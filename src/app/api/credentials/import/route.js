import { NextResponse } from "next/server";
import { importCredentials } from "@/lib/credentials/importer";

export async function POST(request) {
  try {
    const payload = await request.json();
    const result = await importCredentials(payload);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.log("Error importing credentials:", error);

    return NextResponse.json(
      { error: error?.message || "Failed to import credentials" },
      { status: 400 },
    );
  }
}
