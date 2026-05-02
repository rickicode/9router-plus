const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

/**
 * Legacy compatibility stub kept only so tests can assert the old worker-side
 * SQLite upload path stays disabled.
 */
export async function handleSqliteBackupUpload(request, env) {
  return jsonResponse({
    error: "Worker-side SQLite backup upload is deprecated. 9router-plus writes SQLite backups directly to R2.",
    writer: "9router-plus"
  }, 410);
}
