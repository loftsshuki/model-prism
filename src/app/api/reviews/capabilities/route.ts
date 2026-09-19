export async function GET() {
  return Response.json({ background: Boolean(process.env.DATABASE_URL && /^[a-f0-9]{64}$/i.test(process.env.MODEL_PRISM_ENCRYPTION_KEY ?? "")) }, { headers: { "Cache-Control": "no-store" } });
}
