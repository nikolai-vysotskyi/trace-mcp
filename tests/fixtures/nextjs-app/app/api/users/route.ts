export async function GET() {
  return Response.json([]);
}

export async function POST(request: Request) {
  const body = await request.json();
  return Response.json(body);
}
