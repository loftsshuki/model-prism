import { NextRequest } from "next/server";
import { protectedResourceOptions, protectedResourceResponse } from "@/lib/oauth-resource";

export function GET(req: NextRequest) {
  return protectedResourceResponse(req.nextUrl.origin);
}

export function OPTIONS() {
  return protectedResourceOptions();
}
