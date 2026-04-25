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
    console.warn("Error importing credentials", {
      code: error?.code,
      message: error?.message,
    });

    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          error: "Invalid JSON request body",
          errorCode: "INVALID_JSON",
        },
        { status: 400 },
      );
    }

    if (error?.code === "INVALID_LEGACY_STATUS_FIELDS") {
      return NextResponse.json(
        {
          error: error.message,
          errorCode: "INVALID_LEGACY_STATUS_FIELDS",
          legacyFields: error.legacyFields || [],
        },
        { status: 400 },
      );
    }

    if (error?.code === "REPLACE_MODE_VALIDATION_FAILED") {
      return NextResponse.json(
        {
          error: error.message,
          errorCode: "REPLACE_MODE_VALIDATION_FAILED",
          invalidRecords: Array.isArray(error.invalidRecords) ? error.invalidRecords : [],
        },
        { status: 400 },
      );
    }

    if (
      error?.code === "INVALID_IMPORT_PAYLOAD"
      || error?.code === "DUPLICATE_IMPORT_RECORDS"
    ) {
      return NextResponse.json(
        {
          error: error.message,
          errorCode: error.code,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "Failed to import credentials" },
      { status: 500 },
    );
  }
}
