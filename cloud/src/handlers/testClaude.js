export async function handleTestClaude() {
  return new Response(JSON.stringify({
    error: "testClaude is not supported in the Cloudflare Worker build"
  }), {
    status: 501,
    headers: { "Content-Type": "application/json" }
  });
}
