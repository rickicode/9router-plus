/**
 * Landing Page Service
 * Simple health check page for self-hosted worker
 */

/**
 * Create landing page response
 * @returns {Response} HTML response
 */
export function createLandingPageResponse() {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>9Router Worker</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;background:#0a0a0a;color:#eee;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{padding:2rem;border:1px solid #2a2a2a;border-radius:12px;max-width:520px;text-align:center;background:#141414}
h1{margin:0 0 .75rem;font-size:1.4rem}
p{color:#aaa;margin:0 0 .75rem;line-height:1.5}
code{background:#1f1f1f;padding:.1rem .35rem;border-radius:4px;font-size:.85rem}
small{color:#666}
</style></head>
<body><div class="box">
<h1>9Router Worker</h1>
<p>Worker is running. Configure this URL in your 9Router dashboard under <strong>Endpoint &rarr; Cloud</strong>.</p>
<p><small>Status dashboard: <code>/admin/status?token=...</code></small></p>
</div></body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600"
    }
  });
}
