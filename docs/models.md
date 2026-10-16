# Model selection

English · [简体中文](models_zh.md)

Choose a model based on whether you have a reference recording or want a built-in or designed voice. All models generate complete audio before playback.

| Model | Main use | Required input |
| --- | --- | --- |
| IndexTTS 2.0 / 2.5 | Voice cloning and emotion control | Reference audio; 2.0 supports Chinese/English, 2.5 adds Japanese, Spanish, and Arabic |
| VoxCPM2 | Voice design and cloning | A description for designed voices is optional; transcript-assisted cloning uses reference audio and its transcript |
| OmniVoice | Attribute-based voice design and cloning | Predefined attributes for design; audio and a matching transcript for cloning |
| Qwen3-TTS Base · 0.6B / 1.7B | Voice cloning | Reference audio; transcript optional |
| Qwen3-TTS CustomVoice · 1.7B | Built-in voices with style instructions | Speaker ID; optional style description |
| Qwen3-TTS VoiceDesign · 1.7B | Voice design | A voice description |
| Breeze TTS 2 | Chinese and English voice design, cloning, and voice direction | A description is optional for designed voices; cloning requires reference audio and its full transcript; a GPU is recommended |
| Kokoro | Lightweight built-in voices | Speaker ID; no reference audio |

Use `yovoice models list --json` for model IDs, available precisions, file sizes, voices, and advanced parameter definitions. The app lists models in Settings. See the [CLI guide](cli.md) to download an engine and model.

## Voice cloning

```sh
yovoice generate --model index-2.5-q8 --text-file narration.txt --reference voice.wav --output index.wav
yovoice generate --model voxcpm2-q8 --text-file narration.txt --reference voice.wav --reference-text "The exact words spoken in the recording." --output vox.wav
yovoice generate --model omnivoice-q8 --text-file narration.txt --reference voice.wav --reference-text "The exact words spoken in the recording." --output omni.wav
yovoice generate --model qwen3-tts-base-0.6b-q8 --text-file narration.txt --reference voice.wav --output qwen.wav
yovoice generate --model breeze-tts-2-q8 --text-file narration.txt --reference voice.wav --reference-text "The exact words spoken in the recording." --voice-description "Slightly faster, relaxed tone" --output breeze.wav
```

For VoxCPM2, omit `--reference-text` for ordinary cloning. For Qwen3-TTS Base, adding an accurate transcript enables transcript-guided cloning. OmniVoice and Breeze TTS 2 cloning always require a matching transcript. For Breeze, `--voice-description` acts as voice direction when cloning: it keeps the voice and steers pace, emotion and tone.

Use a clear recording with one speaker and little background noise. Reference audio must be 1–60 seconds and no larger than 20 MB.

## Voice design and built-in voices

```sh
yovoice generate --model voxcpm2-q8 --voice-description "A warm, calm adult narrator" --text-file narration.txt --output vox-design.wav
yovoice generate --model omnivoice-q8 --voice-description "female, young adult, moderate pitch" --text-file narration.txt --output omni-design.wav
yovoice generate --model breeze-tts-2-q8 --voice-description "A warm female voice, steady pace, clear diction" --text-file narration.txt --output breeze-design.wav
yovoice generate --model qwen3-tts-voicedesign-q8 --voice-description "A deep, resonant adult narrator" --text-file narration.txt --output qwen-design.wav
yovoice generate --model qwen3-tts-customvoice-q8 --speaker Ryan --voice-description "Speak softly and slowly" --language en --text-file narration.txt --output custom.wav
```

Qwen3-TTS CustomVoice speakers are `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`, `Ryan`, `Aiden`, `Ono_Anna`, and `Sohee`.

OmniVoice design accepts predefined comma-separated attributes, rather than free-form descriptions. Choose at most one attribute per category:

- Gender: `male`, `female`.
- Age: `child`, `teenager`, `young adult`, `middle-aged`, `elderly`.
- Pitch: `very low pitch`, `low pitch`, `moderate pitch`, `high pitch`, `very high pitch`.
- Delivery: `whisper`.

Leave the description empty for an automatic voice. For Kokoro voices and model variants, see [Kokoro](#kokoro) below.

## Expression and advanced options

IndexTTS supports `--emotion-text`, `--emotion-reference`, or `--emotion-vector` to select an expression mode. The eight emotion-vector values are ordered as happy, angry, sad, afraid, disgusted, low, surprised, and calm. Use `--emotion-strength` to adjust intensity and `--speed` for speed. IndexTTS 2.5 also supports pronunciation annotations in the text.

VoxCPM2 uses voice descriptions for speed, emotion, and dialect. `--guidance-scale`, `--inference-steps`, and `--seed` provide additional control. Transcript-assisted cloning follows the reference performance instead of adding a design description.

VoxCPM2 generates autoregressively at 6.25 frames per second. When one chunk runs too long, the voice drifts or breaks into noise, and pitch and loudness slowly sag within the chunk. YoVoice defaults to 200 characters per chunk with a 400-character limit. The default continuation strategy feeds the previous chunk into the next to keep transitions smooth; when cloning, set the long-text strategy to `stateless` to anchor every chunk directly on the reference audio.

OmniVoice supports `--speed`, `--language`, `--guidance-scale`, and `--inference-steps`. Sound tags such as `[laughter]` and `[sigh]` can be inserted into the text. Qwen3-TTS supports `--language auto|zh|en|ja|ko|de|fr|ru|pt|es|it`.

### Breeze TTS 2 and dragging speech

Breeze TTS 2 sounds very natural, but its autoregressive decoder tends to drag, repeat, or trail off into long silence in the cases below. YoVoice adjusts its defaults accordingly:

- **Chunks that are too long.** The model generates 12.5 frames per second with a 2048-frame official context. audio.cpp defaults to 600-character chunks and a 1500-frame (120 s) cap, so long Chinese chunks exceed the training length. YoVoice defaults to 160-character chunks and a 900-frame (about 72 s) cap per chunk; adjust `text_chunk_size` and `max_tokens` under Advanced settings.
- **Non-bf16 inference.** The official implementation runs in bf16; fp32 activations drift into mispronunciation and repetition. YoVoice turns on the bf16 reference path on CUDA, Vulkan and Metal (about 20% slower on Metal). The CPU backend cannot use it and drags more often on long text, so a GPU is recommended.
- **Reference audio and transcript.** Use 5–15 seconds of clean, non-looping speech without background noise, and a word-for-word transcript, including any repeats.
- **Tuning order.** If it still drags, shorten chunks first (for example 80–120 characters), then lower `temperature` to 0.6–0.8. Raise `guidance_scale` to 3–4 to follow the description more closely (roughly doubles generation time). Describe pace and emotion in the same language as the text, for example "slightly faster, relaxed tone".

For long text without reference audio, the v0.9.1 engine picks a voice for each chunk separately, so the voice may change between chunks. For a stable voice, design one on a short line, save it as a voice, and clone from it.

The app shows supported options under Advanced settings. The CLI accepts repeated `--option KEY=JSON` values; query `models list --json` for each model's supported keys and limits:

```sh
yovoice generate --model qwen3-tts-customvoice-q8 --speaker Ryan --text-file narration.txt --option 'temperature=0.7' --option 'text_chunk_size=512' --output advanced.wav
```

## Kokoro

Kokoro generates speech with built-in voices and does not require reference audio.

### Choose a model

| Model ID | Size | Voices and languages | Installation |
| --- | --- | --- | --- |
| `kokoro-82m-q8` | About 190 MB | 49 voices; multilingual, excluding Japanese | Download |
| `kokoro-82m-bf16` | About 212 MB | Same voices as Q8 | Download |
| `kokoro-1.1-zh-q8` | About 255 MB | 100 Chinese and 3 English voices; experimental | Download |

The official models support Chinese, American/British English, Spanish, French, Hindi, Italian, and Brazilian Portuguese. Version 1.1-zh uses different voice IDs from version 1.0.

### Generate speech

```sh
yovoice models download kokoro-82m-q8
yovoice generate --model kokoro-82m-q8 --speaker af_heart --text "Hello, welcome." --output hello.wav
```

Use `yovoice models list --json` to see available voice IDs. Language follows the selected voice. For Chinese, use `zf_xiaobei` with the official models or `zf_001` with version 1.1-zh.

The default chunk size is 64 characters. Adjust it with `--option 'text_chunk_size=120'` if needed; each chunk is still subject to the engine's phoneme limit.

Kokoro does not support voice cloning or text-guided emotion control. Keep the CLI package's `tools/` directory intact. Generation works offline after the engine and model are installed. Full multilingual models may take longer to load the first time.

## Music generation

Music projects in the desktop app use ACE-Step 1.5 Turbo (`ace-step-1.5-turbo-bf16`, about 10.1 GB) and need inference engine v0.9.1 or later.

- **Style**: a short description plus tags such as `city pop, warm synths, chill, female vocals`, up to 512 characters.
- **Lyrics**: mark sections with `[verse]`, `[chorus]`, `[bridge]` and so on, up to 4000 characters. Turn on Instrumental to generate music without vocals; your lyrics are kept.
- **Duration and language**: choose Auto or 10–300 seconds, and a vocal language that matches the lyrics.
- **Arrangement**: tempo (30–300 BPM), key and time signature are planned by the model unless you set them.

Upstream reports that a fully quantized Q8 ACE-Step package makes the planner produce a different song, so only the BF16 package is offered. Continuation, covers, repainting and stem extraction are not available yet.

## Score sound font

Score projects and `yovoice score render` use the MuseScore General sound font (`musescore-general-sf2`, SF2 · about 216 MB) with all 128 General MIDI instruments and drum kits; GeneralUser GS (`generaluser-gs-sf2`, about 32 MB) and SGM-V2.01 (`sgm-v2-sf2`, about 247 MB) are optional alternatives. No inference engine is needed. See [Score](score.md).

## Licenses

OmniVoice weights are licensed under CC-BY-NC for non-commercial use. Breeze TTS 2 weights use the [BreezeBlue Research and Non-Commercial License](https://huggingface.co/BreezeBlue/Breeze-TTS-2), and generated speech is not licensed for commercial use either. IndexTTS has a separate [model license](../web/public/model-license.txt). Check the model publisher's license before using generated speech commercially.
