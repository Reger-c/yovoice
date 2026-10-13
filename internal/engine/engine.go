// Package engine 管理 audio.cpp 推理进程，并把作品参数转换为引擎请求。
package engine

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"yovoice/internal/audio"
	"yovoice/internal/catalog"
	"yovoice/internal/diag"
	"yovoice/internal/msg"
	"yovoice/internal/platform"
	"yovoice/internal/schema"
)

// Engine 可被并发调用：同一时间只运行一个推理请求，停止会等待当前请求结束。
type Engine struct {
	mu            sync.Mutex
	root          string
	process       *exec.Cmd
	done          chan error
	endpoint, key string
	client        *http.Client
}

func New(root string) *Engine {
	ReapOrphan(root)
	return &Engine{root: root, client: &http.Client{Transport: &http.Transport{Proxy: nil}}}
}

func pidPath(root string) string { return filepath.Join(root, "runtime", "engine.pid") }

// ReapOrphan 结束上次服务异常退出后残留的推理进程：它仍占用显存和端口，Windows 上还会锁住内核文件。
// 只结束命令行包含本数据目录 server.json 的进程，避免误杀 PID 被复用的其他程序；
// 数据目录由 service.lock 独占，此时不可能有其他服务正在使用这个推理进程。
func ReapOrphan(root string) {
	path := pidPath(root)
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	defer os.Remove(path)
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 || pid == os.Getpid() {
		return
	}
	command, err := platform.ProcessCommand(pid)
	if err != nil || !strings.Contains(command, filepath.Join(root, "runtime", "server.json")) {
		return
	}
	platform.KillGroup(pid)
	diag.Log(root, "engine.orphan_killed", "pid", pid)
}
func (e *Engine) Stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stop()
}

// stop 要求调用方持有 mu。
func (e *Engine) stop() {
	if e.process != nil {
		platform.KillProcess(e.process)
		<-e.done
		e.process = nil
		e.key = ""
		_ = os.Remove(pidPath(e.root))
	}
}
func (e *Engine) start(ctx context.Context, executable, model string, definition catalog.ModelPackage, backend string, encoderSamples int, progress func(msg.Code, msg.Params)) error {
	family, task := definition.Family, definition.Task
	if task == "" {
		task = "tts"
	}
	key := fmt.Sprintf("%s|%s|%s|%s|%s|%v|%v|%d", executable, model, family, task, backend, definition.LoadOptions, definition.SessionOptions, encoderSamples)
	if e.process != nil && e.key == key {
		select {
		case <-e.done:
			e.process = nil
		default:
			return nil
		}
	}
	e.stop()
	if _, err := os.Stat(executable); err != nil {
		return msg.Err(msg.ErrRuntimeMissing, nil)
	}
	if _, err := os.Stat(model); err != nil {
		return msg.Err(msg.ErrModelMoved, nil)
	}
	progress(msg.ActivityEngineStart, nil)
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	entry := map[string]any{"id": "index", "family": family, "path": model, "task": task, "mode": "offline"}
	if len(definition.LoadOptions) > 0 {
		entry["load_options"] = definition.LoadOptions
	}
	session := map[string]any{}
	for k, v := range definition.SessionOptions {
		session[k] = v
	}
	if encoderSamples > 0 {
		session["voxcpm2.audiovae_encoder_sample_capacity"] = encoderSamples
	}
	if len(session) > 0 {
		entry["session_options"] = session
	}
	config := map[string]any{"host": "127.0.0.1", "port": port, "backend": catalog.ServerBackend(backend), "device": 0, "threads": max(1, min(runtime.NumCPU()/2, 8)), "lazy_load": true, "max_loaded_models": 1, "idle_unload_ms": 300000, "log_request_body": false, "max_request_body_bytes": 1048576, "models": []any{entry}}
	b, err := json.Marshal(config)
	if err != nil {
		return err
	}
	path := filepath.Join(e.root, "runtime", "server.json")
	if err = os.WriteFile(path, b, 0600); err != nil {
		return err
	}
	c := exec.Command(executable, "--config", path, "--no-ui")
	c.Dir = filepath.Dir(executable)
	if family == "kokoro_tts" {
		names := map[string][2]string{
			"darwin":  {"libespeak-ng.dylib", "libmecab.2.dylib"},
			"windows": {"espeak-ng.dll", "libmecab.dll"},
			"linux":   {"libespeak-ng.so", "libmecab.so.2"},
		}[runtime.GOOS]
		c.Env = os.Environ()
		for i, key := range []string{"AUDIOCPP_ESPEAK_LIBRARY", "AUDIOCPP_MECAB_LIBRARY"} {
			library, err := platform.PackagedTool(filepath.Join("kokoro", names[i]))
			if err != nil {
				return msg.Err(msg.ErrRuntimeMissing, nil)
			}
			c.Env = append(c.Env, key+"="+library)
		}
		// 官方小包不包含 eSpeak 数据，由安装包提供；完整包仍可沿用内嵌资源。
		if data, err := platform.PackagedTool(filepath.Join("kokoro", "espeak-ng-data", "phontab")); err == nil {
			c.Env = append(c.Env, "AUDIOCPP_ESPEAK_DATA="+filepath.Dir(data))
		}
	}
	platform.ConfigureProcess(c)
	// 推理日志追加写入，崩溃后重试重新启动引擎时，上一轮的出错原因仍保留在同一文件中。
	out, err := diag.OpenProcessLog(filepath.Join(e.root, "logs", "engine.log.out"), "engine "+family)
	if err != nil {
		return err
	}
	defer out.Close()
	stderr, err := diag.OpenProcessLog(filepath.Join(e.root, "logs", "engine.log"), "engine "+family)
	if err != nil {
		return err
	}
	defer stderr.Close()
	c.Stdout = out
	c.Stderr = stderr
	if err = c.Start(); err != nil {
		return err
	}
	// 服务崩溃或被强制结束时不能留下推理进程：Windows 绑定作业对象，其他系统记录 PID 供下次启动清理。
	if err := platform.TieToParent(c); err != nil {
		diag.Log(e.root, "engine.tie_failed", "error", diag.Error(err))
	}
	_ = os.WriteFile(pidPath(e.root), []byte(strconv.Itoa(c.Process.Pid)), 0600)
	e.process = c
	e.done = make(chan error, 1)
	done := e.done
	go func() { done <- c.Wait(); close(done) }()
	e.endpoint = fmt.Sprintf("http://127.0.0.1:%d/", port)
	attempts := 120
	if family == "kokoro_tts" {
		// 多语言包包含日文词典；首次读取内嵌资源需要更长时间。
		attempts = 1200
	}
	for i := 0; i < attempts; i++ {
		if err = ctx.Err(); err != nil {
			return err
		}
		select {
		case <-e.done:
			e.process = nil
			return msg.Err(msg.ErrEngineStartFailed, nil)
		default:
		}
		probe, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		req, _ := http.NewRequestWithContext(probe, "GET", e.endpoint+"health", nil)
		res, err := e.client.Do(req)
		healthy := err == nil && res.StatusCode == 200
		if res != nil {
			res.Body.Close()
		}
		cancel()
		if healthy {
			e.key = key
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return msg.Err(msg.ErrEngineStartTimeout, nil)
}
func (e *Engine) Generate(ctx context.Context, executable string, m schema.InstalledModel, backend string, d schema.Draft, voice, emotion, output string, progress func(msg.Code, msg.Params)) (err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	defer func() {
		if err != nil {
			e.stop()
		}
		_ = os.Remove(output + ".part")
	}()
	payload, err := BuildRequest(d, voice, emotion)
	if err != nil {
		return err
	}
	definition, err := catalog.Lookup(m.ID)
	if err != nil {
		return err
	}
	encoderSamples := 0
	if definition.Family == "voxcpm2" {
		encoderSamples = 240000
		if d.RequiresVoice() {
			duration, audioErr := audio.Duration(voice)
			if audioErr != nil {
				return audioErr
			}
			if duration < 1 || duration > 60 {
				return msg.Err(msg.ErrAudioDuration, nil)
			}
			// VoxCPM2 先重采样到 16 kHz，再按 4 × 640 个采样点补齐；长参考音频按需扩容。
			encoderSamples = max(encoderSamples, int(math.Ceil(duration*16000/2560))*2560)
		}
	}
	if err = e.start(ctx, executable, m.Path, definition, backend, encoderSamples, progress); err != nil {
		return err
	}
	progress(msg.ActivitySynthesizing, nil)
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", e.endpoint+"v1/tasks/run", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := e.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		_ = os.WriteFile(filepath.Join(e.root, "logs", "last-inference-error.txt"), b, 0600)
		return msg.Err(msg.ErrGenerateFailed, nil)
	}
	var result struct {
		Audio string `json:"audio"`
	}
	if err = json.NewDecoder(io.LimitReader(res.Body, 256<<20)).Decode(&result); err != nil {
		return err
	}
	if result.Audio == "" {
		return msg.Err(msg.ErrEngineNoAudio, nil)
	}
	progress(msg.ActivitySavingAudio, nil)
	wav, err := base64.StdEncoding.DecodeString(result.Audio)
	if err != nil {
		return err
	}
	if err = os.WriteFile(output+".part", wav, 0600); err != nil {
		return err
	}
	if _, err = audio.Duration(output + ".part"); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	return os.Rename(output+".part", output)
}
