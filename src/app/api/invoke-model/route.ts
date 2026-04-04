import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { model, content, prompt, apiKey, maxTokens } = await req.json();

  if (!apiKey) {
    return NextResponse.json(
      { error: "OpenRouter API key required" },
      { status: 401 }
    );
  }

  if (!model || !content || !prompt) {
    return NextResponse.json(
      { error: "model, content, and prompt are required" },
      { status: 400 }
    );
  }

  const startTime = Date.now();

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Model Prism",
          "HTTP-Referer": "https://model-prism.vercel.app",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 4096,
          messages: [
            {
              role: "user",
              content: `${prompt}\n\n---\n\n${content}`,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        {
          error: `OpenRouter error: ${response.status}`,
          details: error,
          timeMs: Date.now() - startTime,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const usage = data.usage;

    return NextResponse.json({
      model,
      response: choice?.message?.content ?? "",
      timeMs: Date.now() - startTime,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      cost:
        (usage?.prompt_tokens ?? 0) * 0 + (usage?.completion_tokens ?? 0) * 0, // OpenRouter includes cost in headers
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
        timeMs: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
