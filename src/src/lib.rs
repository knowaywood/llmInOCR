use futures_util::future::{AbortHandle, Abortable};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

const SETTINGS_FILE: &str = ".llminocr_settings.json";
const DEFAULT_MODEL: &str = "qwen3.6-plus";
const DEFAULT_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";

struct AppState {
    current_abort: Mutex<Option<AbortHandle>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Typst,
    Latex,
    Mathtype,
}

impl Default for OutputFormat {
    fn default() -> Self {
        Self::Latex
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ThemeMode {
    Light,
    Dark,
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::Light
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    output_format: OutputFormat,
    #[serde(default)]
    theme_mode: ThemeMode,
    model: String,
    api_key: Option<String>,
    qwen_base_url: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            output_format: OutputFormat::Latex,
            theme_mode: ThemeMode::Light,
            model: DEFAULT_MODEL.to_string(),
            api_key: None,
            qwen_base_url: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct UpdateSettingsRequest {
    output_format: Option<OutputFormat>,
    theme_mode: Option<ThemeMode>,
    model: Option<String>,
    api_key: Option<String>,
    qwen_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConvertRequest {
    text: Option<String>,
    images: Vec<ImageInput>,
}

#[derive(Debug, Deserialize)]
struct ImageInput {
    name: String,
    data_url: String,
}

#[derive(Debug, Serialize)]
struct ConvertResponse {
    output_format: OutputFormat,
    model: String,
    result: String,
}

fn settings_path() -> Result<PathBuf, String> {
    let cwd = env::current_dir().map_err(|e| format!("Failed to get current directory: {e}"))?;
    Ok(cwd.join(SETTINGS_FILE))
}

fn normalize_settings(settings: AppSettings) -> AppSettings {
    settings
}

fn load_env_file(path: &Path) {
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };

        let key = raw_key.trim();
        if key.is_empty() || env::var_os(key).is_some() {
            continue;
        }

        let value = raw_value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string();

        // We load .env values at startup before any requests begin.
        unsafe { env::set_var(key, value) };
    }
}

fn load_env_files() {
    let Ok(cwd) = env::current_dir() else {
        return;
    };

    load_env_file(&cwd.join(".env"));

    if let Some(parent) = cwd.parent() {
        load_env_file(&parent.join(".env"));
    }
}

fn write_settings(settings: &AppSettings) -> Result<(), String> {
    let settings = normalize_settings(settings.clone());
    let path = settings_path()?;
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to encode settings: {e}"))?;
    fs::write(path, content).map_err(|e| format!("Failed to write settings: {e}"))
}

fn read_settings() -> Result<AppSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        let defaults = AppSettings::default();
        write_settings(&defaults)?;
        return Ok(defaults);
    }

    let payload = fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {e}"))?;
    let parsed = serde_json::from_str::<AppSettings>(&payload)
        .map_err(|e| format!("Invalid settings JSON at {}: {e}", path.display()))?;

    let normalized = normalize_settings(parsed);
    write_settings(&normalized)?;
    Ok(normalized)
}

fn format_instruction(output_format: &OutputFormat) -> String {
    let target = match output_format {
        OutputFormat::Typst => "Typst",
        OutputFormat::Latex => "LaTeX",
        OutputFormat::Mathtype => "MathType",
    };

    let base = format!(
        "You are a precise math conversion assistant. Convert the input to {target}. Return only the converted content, without markdown fences or explanations."
    );

    if !matches!(output_format, OutputFormat::Typst) {
        return base;
    }

    let typst_rules = " Use strict Typst syntax. For inline math, write with single dollar delimiters like `$ x^2 + y^2 $`. For display (block) math, write equation content on its own line with `$ ... $`. Use fraction as `symbol/` form such as `a/b`, `x/(y+1)`, and avoid `frac(...)`. Always use `dots` instead of `cdots` (for example `a_1, a_2, dots, a_n`). Return valid Typst content only.";
    format!("{base}{typst_rules}")
}

fn resolve_api_key(settings: &AppSettings) -> Result<String, String> {
    let from_settings = settings
        .api_key
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !from_settings.is_empty() {
        return Ok(from_settings);
    }

    let qwen = env::var("QWEN_API_KEY").unwrap_or_default();
    if !qwen.trim().is_empty() {
        return Ok(qwen.trim().to_string());
    }

    let dashscope = env::var("DASHSCOPE_API_KEY").unwrap_or_default();
    if !dashscope.trim().is_empty() {
        return Ok(dashscope.trim().to_string());
    }

    let deepseek = env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    if !deepseek.trim().is_empty() {
        return Ok(deepseek.trim().to_string());
    }

    Err("API key is not configured. Set it in Settings, or .env via QWEN_API_KEY / DASHSCOPE_API_KEY / DEEPSEEK_API_KEY.".to_string())
}

fn resolve_base_url(settings: &AppSettings) -> String {
    let from_settings = settings
        .qwen_base_url
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !from_settings.is_empty() {
        return from_settings;
    }

    let from_env = env::var("QWEN_BASE_URL").unwrap_or_default();
    if !from_env.trim().is_empty() {
        return from_env.trim().to_string();
    }

    let deepseek_env = env::var("DEEPSEEK_BASE_URL").unwrap_or_default();
    if !deepseek_env.trim().is_empty() {
        return deepseek_env.trim().to_string();
    }

    DEFAULT_BASE_URL.to_string()
}

fn extract_result_content(response: &Value) -> Result<String, String> {
    let content = &response["choices"][0]["message"]["content"];

    if let Some(text) = content.as_str() {
        return Ok(text.trim().to_string());
    }

    if let Some(items) = content.as_array() {
        let mut fragments = Vec::new();
        for item in items {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                fragments.push(text.trim().to_string());
            }
        }
        let joined = fragments.join("\n").trim().to_string();
        if !joined.is_empty() {
            return Ok(joined);
        }
    }

    Err(format!("Unexpected Qwen response format: {response}"))
}

#[tauri::command]
fn get_settings() -> Result<AppSettings, String> {
    read_settings()
}

#[tauri::command]
fn update_settings(req: UpdateSettingsRequest) -> Result<AppSettings, String> {
    let mut current = read_settings()?;

    if let Some(output_format) = req.output_format {
        current.output_format = output_format;
    }

    if let Some(theme_mode) = req.theme_mode {
        current.theme_mode = theme_mode;
    }

    if let Some(model) = req.model {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            return Err("Model cannot be empty.".to_string());
        }
        current.model = trimmed.to_string();
    }

    current.api_key = req.api_key.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    current.qwen_base_url = req.qwen_base_url.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    write_settings(&current)?;
    read_settings()
}

#[tauri::command]
fn cancel_convert(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let mut current_abort = state
        .current_abort
        .lock()
        .map_err(|_| "Failed to access conversion state.".to_string())?;

    if let Some(handle) = current_abort.take() {
        handle.abort();
    }

    Ok(())
}

#[tauri::command]
async fn convert(
    req: ConvertRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ConvertResponse, String> {
    let settings = read_settings()?;
    let (abort_handle, abort_registration) = AbortHandle::new_pair();

    {
        let mut current_abort = state
            .current_abort
            .lock()
            .map_err(|_| "Failed to access conversion state.".to_string())?;
        *current_abort = Some(abort_handle);
    }

    let request_future = async move {
        let has_images = !req.images.is_empty();
        let text = req.text.unwrap_or_default().trim().to_string();

        if !has_images && text.is_empty() {
            return Err("Please enter text or attach images first.".to_string());
        }

        let messages = if has_images {
            let mut content = Vec::new();
            for image in &req.images {
                if image.data_url.trim().is_empty() {
                    continue;
                }
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": image.data_url }
                }));
            }

            if content.is_empty() {
                return Err("Current image data is invalid. Please re-add images.".to_string());
            }

            let prompt = if req.images.len() > 1 {
                "Extract and convert all mathematical content from all images in order."
            } else {
                "Extract and convert all mathematical content from this image."
            };

            content.push(json!({ "type": "text", "text": prompt }));

            json!([
                {
                    "role": "system",
                    "content": format_instruction(&settings.output_format)
                },
                {
                    "role": "user",
                    "content": content
                }
            ])
        } else {
            json!([
                {
                    "role": "system",
                    "content": format_instruction(&settings.output_format)
                },
                {
                    "role": "user",
                    "content": text
                }
            ])
        };

        let api_key = resolve_api_key(&settings)?;
        let base_url = resolve_base_url(&settings);
        let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));

        let body = json!({
            "model": settings.model,
            "messages": messages,
            "temperature": 0
        });

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {e}"))?;
        let resp = client
            .post(endpoint)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Qwen request failed: {e}"))?;

        let status = resp.status();
        let raw = resp
            .text()
            .await
            .map_err(|e| format!("Qwen request failed while reading response: {e}"))?;

        if !status.is_success() {
            return Err(format!("Qwen request failed ({status}): {raw}"));
        }

        let parsed: Value = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid Qwen response JSON: {e}. Raw: {raw}"))?;
        let result = extract_result_content(&parsed)?;

        Ok(ConvertResponse {
            output_format: settings.output_format,
            model: settings.model,
            result,
        })
    };

    let result = Abortable::new(request_future, abort_registration).await;

    if let Ok(mut current_abort) = state.current_abort.lock() {
        *current_abort = None;
    }

    match result {
        Ok(response) => response,
        Err(_) => Err("Conversion cancelled.".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_env_files();

    tauri::Builder::default()
        .manage(AppState {
            current_abort: Mutex::new(None),
        })
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            cancel_convert,
            convert
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
