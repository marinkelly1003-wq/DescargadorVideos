use tauri::{AppHandle, Emitter, Manager};
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn new_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct VideoInfo {
    id: String,
    title: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    uploader: Option<String>,
    url: String,
    views: Option<u64>,
    playlist_title: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ProgressPayload {
    task_id: String,
    percent: f64,
    size: String,
    speed: String,
    eta: String,
    status: String,
    error: Option<String>,
}

#[tauri::command]
fn get_download_directory(app_handle: AppHandle) -> Result<String, String> {
    match app_handle.path().download_dir() {
        Ok(path) => Ok(path.to_string_lossy().to_string()),
        Err(_) => Ok(std::env::temp_dir().to_string_lossy().to_string()),
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let folder_path = Path::new(&path);
    if !folder_path.exists() {
        return Err("El directorio no existe".to_string());
    }
    Command::new("explorer")
        .arg(folder_path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn search_videos(query: String) -> Result<Vec<VideoInfo>, String> {
    // Search using yt-dlp --dump-json "ytsearch10:<query>"
    let output = new_command("yt-dlp")
        .args(&[
            "--dump-json",
            &format!("ytsearch12:{}", query),
            "--no-playlist",
            "--ignore-errors",
        ])
        .output()
        .map_err(|e| format!("Error al ejecutar yt-dlp: {e}"))?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let mut videos = Vec::new();

    for line in stdout_str.lines() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let title = val.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let url = val.get("webpage_url").and_then(|v| v.as_str()).unwrap_or(&format!("https://www.youtube.com/watch?v={}", id)).to_string();
            let thumbnail = val.get("thumbnail").and_then(|v| v.as_str()).map(|s| s.to_string());
            let duration = val.get("duration").and_then(|v| v.as_f64());
            let uploader = val.get("uploader").and_then(|v| v.as_str()).map(|s| s.to_string());
            let views = val.get("view_count").and_then(|v| v.as_u64());

            videos.push(VideoInfo {
                id,
                title,
                thumbnail,
                duration,
                uploader,
                url,
                views,
                playlist_title: None,
            });
        }
    }

    Ok(videos)
}

#[tauri::command]
async fn get_video_info(url: String) -> Result<Vec<VideoInfo>, String> {
    // Get info using flat-playlist first to check if it's a playlist or video very fast
    let output = new_command("yt-dlp")
        .args(&[
            "--dump-json",
            "--flat-playlist",
            "--ignore-errors",
            &url,
        ])
        .output()
        .map_err(|e| format!("Error al ejecutar yt-dlp: {e}"))?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let mut videos = Vec::new();

    for line in stdout_str.lines() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let title = val.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
            
            // For playlists, it might not have webpage_url directly on flat list
            let webpage_url = val.get("webpage_url").and_then(|v| v.as_str())
                .or_else(|| val.get("url").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={}", id));

            let thumbnail = val.get("thumbnail").and_then(|v| v.as_str())
                .or_else(|| val.get("thumbnails").and_then(|t| t.as_array()).and_then(|a| a.last()).and_then(|item| item.get("url")).and_then(|u| u.as_str()))
                .map(|s| s.to_string());
            let duration = val.get("duration").and_then(|v| v.as_f64());
            let uploader = val.get("uploader").and_then(|v| v.as_str()).map(|s| s.to_string());
            let views = val.get("view_count").and_then(|v| v.as_u64());
            let playlist_title = val.get("playlist_title").and_then(|v| v.as_str()).map(|s| s.to_string());

            videos.push(VideoInfo {
                id,
                title,
                thumbnail,
                duration,
                uploader,
                url: webpage_url,
                views,
                playlist_title,
            });
        }
    }

    if videos.is_empty() {
        return Err("No se pudo obtener información del enlace. Asegúrate de que es correcto.".to_string());
    }

    Ok(videos)
}

#[tauri::command]
fn download_video(
    app_handle: AppHandle,
    url: String,
    output_dir: String,
    format_type: String, // "video" or "audio"
    task_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn(async move {
        // Output template: %(title)s.%(ext)s
        let out_template = Path::new(&output_dir)
            .join("%(title)s.%(ext)s")
            .to_string_lossy()
            .to_string();

        let format_arg = if format_type == "audio" {
            "bestaudio/best"
        } else {
            "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        };

        let mut args = vec![
            "--newline",
            "-f",
            format_arg,
            "-o",
            &out_template,
        ];

        if format_type == "audio" {
            args.push("-x");
            args.push("--audio-format");
            args.push("mp3");
            args.push("--audio-quality");
            args.push("0");
        }

        // Add the url
        args.push(&url);

        let mut child = match new_command("yt-dlp")
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        task_id: task_id.clone(),
                        percent: 0.0,
                        size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status: "error".to_string(),
                        error: Some(e.to_string()),
                    },
                );
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);

        for line_res in reader.lines() {
            if let Ok(line) = line_res {
                let line_trimmed = line.trim();
                // Check if progress line
                if line_trimmed.starts_with("[download]") {
                    if let Some(percent_idx) = line_trimmed.find('%') {
                        let percent_str = &line_trimmed[10..percent_idx].trim();
                        if let Ok(percent) = percent_str.parse::<f64>() {
                            let parts: Vec<&str> = line_trimmed.split_whitespace().collect();
                            
                            // Parts: ["[download]", "XX.X%", "of", "SIZE", "at", "SPEED", "ETA", "TIME"]
                            let size = parts.get(3).cloned().unwrap_or("").to_string();
                            let speed = parts.get(5).cloned().unwrap_or("").to_string();
                            let eta = parts.get(7).cloned().unwrap_or("").to_string();

                            let _ = app_handle.emit(
                                "download-progress",
                                ProgressPayload {
                                    task_id: task_id.clone(),
                                    percent,
                                    size,
                                    speed,
                                    eta,
                                    status: "downloading".to_string(),
                                    error: None,
                                },
                            );
                        }
                    }
                }
            }
        }

        let status = child.wait();
        match status {
            Ok(s) if s.success() => {
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        task_id: task_id.clone(),
                        percent: 100.0,
                        size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status: "completed".to_string(),
                        error: None,
                    },
                );
            }
            Ok(_) => {
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        task_id: task_id.clone(),
                        percent: 0.0,
                        size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status: "error".to_string(),
                        error: Some("Error durante la descarga o procesamiento.".to_string()),
                    },
                );
            }
            Err(e) => {
                let _ = app_handle.emit(
                    "download-progress",
                    ProgressPayload {
                        task_id: task_id.clone(),
                        percent: 0.0,
                        size: "".to_string(),
                        speed: "".to_string(),
                        eta: "".to_string(),
                        status: "error".to_string(),
                        error: Some(e.to_string()),
                    },
                );
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            tauri::async_runtime::spawn(async {
                // Ejecutar actualización de yt-dlp de forma silenciosa al iniciar
                let _ = new_command("yt-dlp")
                    .arg("-U")
                    .status();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_download_directory,
            open_folder,
            search_videos,
            get_video_info,
            download_video
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

