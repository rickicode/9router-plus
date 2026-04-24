import { NextResponse } from "next/server";
import { getInternalProxyTokens, regenerateInternalProxyTokens } from "@/lib/internalProxyTokens";

export async function GET() {
  try {
    const tokens = await getInternalProxyTokens();
    return NextResponse.json(tokens);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    const tokens = await regenerateInternalProxyTokens();
    return NextResponse.json(tokens);
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
