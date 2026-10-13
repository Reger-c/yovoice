package remote

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"yovoice/internal/catalog"
	"yovoice/internal/schema"
	"yovoice/internal/workbench"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// newMCPHandler 由官方 SDK 处理协议协商与传输，工具与 HTTP 共用实例和并发限制。
func (a *API) newMCPHandler() http.Handler {
	server := a.newMCPServer()
	return mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 28 << 20, PropagateRequestCancellation: true})
}

// RunMCP 在给定传输上运行 MCP，直到客户端断开或 ctx 取消；命令行以标准输入输出启动。
func (a *API) RunMCP(ctx context.Context, transport mcp.Transport) error {
	return a.newMCPServer().Run(ctx, transport)
}

// audioResult 返回生成结果：远程客户端经 downloadPath 下载，本机模式直接给出 WAV 路径。
func (a *API) audioResult(g schema.Generation) map[string]any {
	if a.Local {
		path, err := a.Workbench.MediaFile("outputs", g.ID)
		if err == nil {
			return map[string]any{"id": g.ID, "duration": g.Duration, "path": path}
		}
	}
	return map[string]any{"id": g.ID, "duration": g.Duration, "downloadPath": "/v1/audio/" + g.ID}
}

func (a *API) newMCPServer() *mcp.Server {
	download := "通过服务端地址加 downloadPath 下载 WAV，HTTP 请求需携带相同 Bearer Token；不返回服务器本地路径"
	upload := "上传 Base64 编码的参考音频，限 20 MB、1–60 秒，返回 voiceId。大文件优先通过 HTTP POST /v1/voices 上传"
	if a.Local {
		download = "path 为本机 WAV 文件的绝对路径"
		upload = "导入参考音频，返回 voiceId。传 path（本机音频文件路径，常见格式自动转换）或 Base64 编码的 audio，限 20 MB、1–60 秒"
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "yovoice", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "status", Description: "查看推理引擎及当前任务状态"}, func(ctx context.Context, req *mcp.CallToolRequest, in struct{}) (*mcp.CallToolResult, any, error) {
		s := a.Workbench.Store.Read()
		return nil, map[string]any{"engineVersion": catalog.EngineVersion, "engineMinimum": catalog.EngineMinimum, "activity": s.Activity, "modelActivity": s.ModelActivity, "runtimeVersion": s.RuntimeVersion, "ready": workbench.RuntimeReady(s)}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "list_models", Description: "查询模型 ID、安装状态和高级参数定义；生成前选择已安装模型"}, func(ctx context.Context, req *mcp.CallToolRequest, in struct{}) (*mcp.CallToolResult, any, error) {
		return nil, map[string]any{"catalog": catalog.Models, "installed": a.Workbench.Store.Read().Models, "generationOptions": catalog.GenerationOptions}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "list_voices", Description: "列出已上传参考音色及 voiceId"}, func(ctx context.Context, req *mcp.CallToolRequest, in struct{}) (*mcp.CallToolResult, any, error) {
		return nil, map[string]any{"voices": a.Workbench.Store.Read().Voices}, nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "upload_voice", Description: upload}, func(ctx context.Context, req *mcp.CallToolRequest, in struct {
		Audio string `json:"audio,omitempty" jsonschema:"参考音频的纯 Base64 字符串，不含 data URL 前缀"`
		Path  string `json:"path,omitempty" jsonschema:"本机音频文件路径，仅 yovoice mcp（stdio）可用"`
		Name  string `json:"name,omitempty" jsonschema:"音色名称"`
	}) (*mcp.CallToolResult, any, error) {
		if !a.busy.TryLock() {
			return nil, nil, fmt.Errorf("推理服务繁忙，请稍后重试")
		}
		defer a.busy.Unlock()
		if in.Path != "" {
			// 远程服务不读取服务器上的任意路径，只有本机 stdio 模式允许。
			if !a.Local {
				return nil, nil, fmt.Errorf("远程服务不支持 path，请上传 Base64 音频")
			}
			voice, err := a.Workbench.ImportVoice(ctx, in.Path, in.Name)
			return nil, voice, err
		}
		if len(in.Audio) > base64.StdEncoding.EncodedLen(20<<20) {
			return nil, nil, fmt.Errorf("音频超过 20 MB")
		}
		data, err := base64.StdEncoding.DecodeString(in.Audio)
		if err != nil {
			return nil, nil, err
		}
		voice, err := a.Workbench.ImportVoiceFrom(ctx, bytes.NewReader(data), in.Name)
		return nil, voice, err
	})
	mcp.AddTool(server, &mcp.Tool{Name: "generate", Description: "同步生成，长耗时优先使用 submit_generation。完整生成语音，返回 id、duration 和音频位置。" + download}, func(ctx context.Context, req *mcp.CallToolRequest, in struct {
		Text     string         `json:"text" jsonschema:"需要朗读的正文"`
		Settings map[string]any `json:"settings,omitempty" jsonschema:"声音参数，与 HTTP API 同名，例如 modelId、voiceId、voxMode、voiceDescription、speaker、referenceText、seed、modelOptions"`
	}) (*mcp.CallToolResult, any, error) {
		if !a.busy.TryLock() {
			return nil, nil, fmt.Errorf("推理服务繁忙，请稍后重试")
		}
		defer a.busy.Unlock()
		if in.Settings == nil {
			in.Settings = map[string]any{}
		}
		in.Settings["text"] = in.Text
		data, err := json.Marshal(in.Settings)
		if err != nil {
			return nil, nil, err
		}
		if len(data) > 1<<20 {
			return nil, nil, fmt.Errorf("生成参数超过 1 MB")
		}
		d, err := decodeGeneration(bytes.NewReader(data))
		if err != nil {
			return nil, nil, err
		}
		g, err := a.generateAudio(ctx, d)
		if err != nil {
			return nil, nil, err
		}
		return nil, a.audioResult(g), nil
	})
	mcp.AddTool(server, &mcp.Tool{Name: "submit_generation", Description: "提交异步语音生成，立即返回任务状态。requestId 为客户端生成的32位十六进制随机ID；相同ID和参数重试不会重复生成。随后用 get_generation 查询，完成后取得音频。优先使用此工具避免长连接超时"}, func(ctx context.Context, req *mcp.CallToolRequest, in struct {
		RequestID string         `json:"requestId"`
		Text      string         `json:"text"`
		Settings  map[string]any `json:"settings,omitempty"`
	}) (*mcp.CallToolResult, any, error) {
		if in.Settings == nil {
			in.Settings = map[string]any{}
		}
		in.Settings["text"] = in.Text
		data, err := json.Marshal(in.Settings)
		if err != nil {
			return nil, nil, err
		}
		if len(data) > 1<<20 {
			return nil, nil, fmt.Errorf("生成参数超过 1 MB")
		}
		d, err := decodeGeneration(bytes.NewReader(data))
		if err != nil {
			return nil, nil, err
		}
		job, err := a.submitJob(in.RequestID, d)
		return nil, job, err
	})
	mcp.AddTool(server, &mcp.Tool{Name: "render_score", Description: "把编曲乐谱渲染为混音 WAV，返回 id、duration 和音频位置（远程为 downloadPath，本机为 path）。乐谱以小节和拍为单位：tempo、timeSignature、可选 sections（段落及变速），tracks 每个声部含 program（GM 音色号）或 drums、role（melody/piano/strings/bass/drums/pad/arp/other，决定默认电平）、notes（bar、beat 从 1 开始、pitch 为 MIDI 音高、length 以拍计、velocity），可选 level、pan、reverb、humanize、dynamics。soundFont 选择已安装的音色库（musescore-general-sf2 默认、generaluser-gs-sf2、sgm-v2-sf2）"}, func(ctx context.Context, req *mcp.CallToolRequest, in struct {
		Title     string       `json:"title,omitempty" jsonschema:"作品标题"`
		SoundFont string       `json:"soundFont,omitempty" jsonschema:"音色库 ID，默认 musescore-general-sf2"`
		Score     schema.Score `json:"score" jsonschema:"乐谱"`
	}) (*mcp.CallToolResult, any, error) {
		if in.SoundFont == "" {
			in.SoundFont = "musescore-general-sf2"
		}
		if m, err := catalog.Lookup(in.SoundFont); err != nil || m.Family != "soundfont" {
			return nil, nil, fmt.Errorf("未知音色库：%s", in.SoundFont)
		}
		if !a.busy.TryLock() {
			return nil, nil, fmt.Errorf("推理服务繁忙，请稍后重试")
		}
		defer a.busy.Unlock()
		d := schema.DefaultDraft()
		d.Kind, d.ModelID, d.Title, d.Score = "score", in.SoundFont, in.Title, &in.Score
		if d.Title == "" {
			d.Title = "API 编曲"
		}
		if err := schema.Validate(d); err != nil {
			return nil, nil, err
		}
		g, err := a.generateAudio(ctx, d)
		if err != nil {
			return nil, nil, err
		}
		return nil, a.audioResult(g), nil
	})
	for _, name := range []string{"get_generation", "cancel_generation"} {
		mcp.AddTool(server, &mcp.Tool{Name: name, Description: map[string]string{"get_generation": "按 requestId 查询任务；建议每2–5秒查询，completed 后用 downloadPath 下载（本机模式直接返回 path）", "cancel_generation": "按 requestId 取消任务；取消后查询至终态，终态任务保持不变"}[name]}, func(ctx context.Context, req *mcp.CallToolRequest, in struct {
			RequestID string `json:"requestId"`
		}) (*mcp.CallToolResult, any, error) {
			job, err := a.getJob(in.RequestID, name == "cancel_generation")
			return nil, job, err
		})
	}

	return server
}
