package workbench

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"yovoice/internal/llm"
	"yovoice/internal/msg"
	"yovoice/internal/schema"
)

// 服务配置写入状态，密钥只在状态库的私有设置中；清除与删除同步移除密钥。
func TestAIProviderKeysStayOutOfState(t *testing.T) {
	w, err := New(t.TempDir())
	must(t, err)
	defer w.Close()
	key := "sk-very-secret-key-000"
	p, err := w.SaveAIProvider(AIProviderInput{Preset: "deepseek", BaseURL: "http://evil.test", Format: "responses", Key: &key, Model: "deepseek-chat"})
	must(t, err)
	if p.BaseURL != "https://api.deepseek.com" || p.Format != "chat_completions" || p.KeyMask != "sk-v••••••••-000" {
		t.Fatalf("固定预设应忽略地址与协议：%+v", p)
	}
	if w.Store.Read().AIProviderID != p.ID {
		t.Fatal("第一个服务应成为当前服务")
	}
	if state, _ := json.Marshal(w.Store.Read()); strings.Contains(string(state), key) {
		t.Fatal("密钥不应出现在广播给界面的状态中")
	}
	info, err := os.Stat(filepath.Join(w.Store.Root, "yovoice.db"))
	must(t, err)
	if info.Mode().Perm()&0077 != 0 && os.PathSeparator == '/' {
		t.Fatal("状态库权限应为 0600", info.Mode())
	}
	// 不传 Key 时保留密钥。
	p, err = w.SaveAIProvider(AIProviderInput{ID: p.ID, Preset: "deepseek", Name: "我的 DeepSeek", Model: "deepseek-reasoner"})
	must(t, err)
	if _, c, _ := w.aiConfig(""); c.Key != key || p.Name != "我的 DeepSeek" {
		t.Fatal("未传密钥时应保留原密钥")
	}
	if _, err = w.SaveAIProvider(AIProviderInput{Preset: "custom", BaseURL: "ftp://x", Format: "chat_completions"}); err == nil {
		t.Fatal("应拒绝非 http 地址")
	}
	local, err := w.SaveAIProvider(AIProviderInput{Preset: "ollama", BaseURL: "http://192.168.1.5:11434/v1", Format: "anthropic_messages"})
	must(t, err)
	if local.BaseURL != "http://192.168.1.5:11434/v1" || local.Format != "chat_completions" {
		t.Fatalf("本地服务只允许改地址：%+v", local)
	}
	// 写作栏切换服务与模型：同时改当前服务和它的模型，模型留空时保持原值。
	must(t, w.UseAIProvider(local.ID, "qwen3:8b"))
	must(t, w.UseAIProvider(p.ID, ""))
	if s := w.Store.Read(); s.AIProviderID != p.ID || s.AIProviders[0].Model != "deepseek-reasoner" || s.AIProviders[1].Model != "qwen3:8b" {
		t.Fatalf("切换服务与模型错误：%+v", s.AIProviders)
	}
	if w.UseAIProvider("missing", "") == nil {
		t.Fatal("应拒绝不存在的服务")
	}
	must(t, w.DeleteAIProvider(p.ID))
	keys, err := w.readSecrets()
	must(t, err)
	if _, ok := keys[p.ID]; ok || w.Store.Read().AIProviderID != local.ID {
		t.Fatal("删除服务应移除密钥并切换当前服务")
	}
}

// fakeLLM 依次返回给定的回复，记录收到的请求。
func fakeLLM(t *testing.T, replies ...string) (*httptest.Server, *[]map[string]any) {
	var requests []map[string]any
	var n atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"data":[{"id":"qwen3"},{"id":"llama3"}]}`))
			return
		}
		var body map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		requests = append(requests, body)
		i := int(n.Add(1)) - 1
		reply, _ := json.Marshal(replies[min(i, len(replies)-1)])
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":` + string(reply) + `},"finish_reason":"stop"}]}`))
	}))
	t.Cleanup(server.Close)
	return server, &requests
}

func aiWorkbench(t *testing.T, server *httptest.Server) *Workbench {
	w, err := New(t.TempDir())
	must(t, err)
	t.Cleanup(w.Close)
	_, err = w.SaveAIProvider(AIProviderInput{Preset: "ollama", BaseURL: server.URL + "/v1"})
	must(t, err)
	return w
}

// 模型列表与连通测试的结果写回服务。
func TestAIModelsAndTest(t *testing.T) {
	server, _ := fakeLLM(t, "OK")
	w := aiWorkbench(t, server)
	id := w.Store.Read().AIProviderID
	models, err := w.AIModels(context.Background(), id)
	must(t, err)
	p := w.Store.Read().AIProviders[0]
	if len(models) != 2 || p.Model != "llama3" || len(p.Models) != 2 {
		t.Fatalf("应保存模型列表并选中第一个：%+v", p)
	}
	result, err := w.TestAIProvider(context.Background(), id)
	must(t, err)
	if !result.OK || w.Store.Read().AIProviders[0].LastTest == nil {
		t.Fatal("测试结果应记录在服务上", result)
	}
}

// AI 写谱：接受紧凑数组音符；首次结果不合规时把问题发回，第二次合规即返回。
func TestComposeScoreRepairsOnce(t *testing.T) {
	bad := `{"tempo":100,"timeSignature":[4,4],"tracks":[{"id":"p","name":"钢琴","role":"piano","program":0,"notes":[[1,5,60,1,80]]}]}`
	good := "好的：\n```json\n" + `{"tempo":100,"timeSignature":[4,4],"key":"C 大调","sections":[{"name":"主歌","start":1,"end":2}],"tracks":[{"id":"p","name":"钢琴","role":"piano","program":0,"notes":[[1,1,60,1,80],[2,1.5,64,0.5,70]]},{"id":"d","name":"鼓","role":"drums","program":0,"drums":true,"notes":[{"bar":1,"beat":1,"pitch":36,"length":0.25,"velocity":100}]}]}` + "\n```"
	server, requests := fakeLLM(t, bad, good)
	w := aiWorkbench(t, server)
	_, err := w.AIModels(context.Background(), "")
	must(t, err)
	s, err := w.ComposeScore(context.Background(), ScoreBrief{Brief: "温暖的钢琴小品", Seconds: 10, Locale: schema.UiLocaleZhCN})
	must(t, err)
	if len(s.Tracks) != 2 || s.Tracks[0].Notes[1].Beat != 1.5 || !s.Tracks[1].Drums {
		t.Fatalf("乐谱解析不对：%+v", s)
	}
	if len(*requests) != 2 {
		t.Fatal("应修复一次", len(*requests))
	}
	last := (*requests)[1]["messages"].([]any)
	fix := last[len(last)-1].(map[string]any)["content"].(string)
	if !strings.Contains(fix, "beat 5") || !strings.Contains((*requests)[0]["messages"].([]any)[0].(map[string]any)["content"].(string), "Simplified Chinese") {
		t.Fatal("修复请求应带上具体问题", fix)
	}

	server, _ = fakeLLM(t, "不是 JSON")
	w = aiWorkbench(t, server)
	_, err = w.AIModels(context.Background(), "")
	must(t, err)
	var ce *msg.CallError
	if _, err = w.ComposeScore(context.Background(), ScoreBrief{Brief: "x"}); !errors.As(err, &ce) || ce.Code != msg.ErrAIResultInvalid {
		t.Fatal("两次都不合规应返回 aiResultInvalid", err)
	}
}

func TestWriteLyricsAndNotConfigured(t *testing.T) {
	w, err := New(t.TempDir())
	must(t, err)
	defer w.Close()
	var ce *msg.CallError
	if _, err = w.WriteLyrics(context.Background(), LyricsBrief{Brief: "夏天"}); !errors.As(err, &ce) || ce.Code != msg.ErrAINotConfigured {
		t.Fatal("未配置服务时应返回 aiNotConfigured", err)
	}
	server, _ := fakeLLM(t, `{"title":"夏夜","style":"city pop, warm synths","lyrics":"[verse]\n晚风吹过","language":"xx"}`)
	w = aiWorkbench(t, server)
	_, err = w.AIModels(context.Background(), "")
	must(t, err)
	l, err := w.WriteLyrics(context.Background(), LyricsBrief{Brief: "夏天的晚风", Language: "zh"})
	must(t, err)
	if l.Title != "夏夜" || l.Style != "city pop, warm synths" || !strings.HasPrefix(l.Lyrics, "[verse]") || l.Language != "" {
		t.Fatalf("%+v", l)
	}
}

// waitAI 等待后台任务结束并返回最终状态。
func waitAI(t *testing.T, w *Workbench) schema.AITask {
	t.Helper()
	changes, stop := w.Store.Subscribe()
	defer stop()
	deadline := time.After(10 * time.Second)
	for {
		if task := w.Store.Read().AITask; task != nil && task.Status != "running" {
			return *task
		}
		select {
		case <-changes:
		case <-deadline:
			t.Fatal("AI 任务没有结束")
		}
	}
}

// 后台任务：立即返回运行中的任务，完成后结果写回状态，界面取用后清除。
func TestAITaskCompletesInBackground(t *testing.T) {
	server, _ := fakeLLM(t, `{"title":"夏夜","style":"city pop","lyrics":"[verse]\n晚风","language":"zh"}`)
	w := aiWorkbench(t, server)
	_, err := w.AIModels(context.Background(), "")
	must(t, err)
	task, err := w.StartLyrics(LyricsBrief{ProjectID: "p1", Brief: "夏天"})
	must(t, err)
	if task.Status != "running" || task.ProjectID != "p1" || task.Model != "llama3" || task.Timeout != schema.AITimeoutDefault {
		t.Fatalf("应返回运行中的任务：%+v", task)
	}
	done := waitAI(t, w)
	var l Lyrics
	if done.Status != "completed" || json.Unmarshal(done.Result, &l) != nil || l.Title != "夏夜" || done.FinishedAt == nil {
		t.Fatalf("结果应写回状态：%+v", done)
	}
	must(t, w.DismissAI(done.ID))
	if w.Store.Read().AITask != nil {
		t.Fatal("取用后应清除任务")
	}
	var ce *msg.CallError
	if _, err = w.StartScore(ScoreBrief{Brief: " "}); !errors.As(err, &ce) || ce.Code != msg.ErrRequestInvalid {
		t.Fatal("无效输入应立即报错", err)
	}
}

// 超时按设置计时，失败原因带上秒数，界面据此提示去设置里延长。
func TestAITaskTimeout(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	w := aiWorkbench(t, server)
	_, err := w.AIModels(context.Background(), "")
	must(t, err)
	p := w.Store.Read().Preferences
	p.AITimeout = 1
	if err = w.SavePreferences(p); err == nil {
		t.Fatal("超时低于下限应拒绝")
	}
	p.AITimeout = schema.AITimeoutMin
	must(t, w.SavePreferences(p))
	if aiTimeout(w.Store.Read().Preferences) != time.Duration(schema.AITimeoutMin)*time.Second {
		t.Fatal("应使用设置的超时")
	}
	// 测试里不等 30 秒：直接用很短的超时验证错误转换。
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err = w.complete(ctx, llm.Request{System: "s", Messages: []llm.Message{{Role: "user", Content: "x"}}})
	var ce *msg.CallError
	if !errors.As(err, &ce) || ce.Code != msg.ErrAINetwork && ce.Code != msg.ErrAITimeout {
		t.Fatal("超时应返回可读的错误", err)
	}
}

// 取消会中止正在进行的任务，且同一时间只允许一个 AI 任务。
func TestCancelAI(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"data":[{"id":"m"}]}`))
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	w := aiWorkbench(t, server)
	_, err := w.AIModels(context.Background(), "")
	must(t, err)
	_, err = w.StartLyrics(LyricsBrief{Brief: "x"})
	must(t, err)
	var ce *msg.CallError
	if _, err = w.StartLyrics(LyricsBrief{Brief: "y"}); !errors.As(err, &ce) || ce.Code != msg.ErrBusy {
		t.Fatal("并发请求应返回 busy", err)
	}
	w.CancelAI()
	if task := waitAI(t, w); task.Status != "cancelled" {
		t.Fatal("取消后任务应为 cancelled", task)
	}
	if _, err = w.StartLyrics(LyricsBrief{Brief: "z"}); err != nil {
		t.Fatal("结束后应能再次开始", err)
	}
}
