# llmInOCR (Rust + Tauri)

This just a toy project

Desktop app for converting text/images into `typst` / `latex` / `mathtype` via Qwen (OpenAI-compatible API).

## Stack

- Backend: Rust + Tauri commands
- Frontend: Vanilla HTML/CSS/JS
- Settings file: `.llminocr_settings.json` (project root)

## 1. Install Rust + Tauri toolchain (Ubuntu)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cargo install tauri-cli --locked
```

## 2. Install Linux system dependencies (required by Tauri/WebKit)

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config \
  patchelf
```

## 3. Configure API key

Set one of:

```bash
export QWEN_API_KEY=your_qwen_api_key
# or
export DASHSCOPE_API_KEY=your_dashscope_api_key
export QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

You can also configure API key and base URL in the app Settings tab.

## 4. Run

```bash
cd src
cargo tauri dev
```

## 5. Build

```bash
cd src
cargo tauri build
```
