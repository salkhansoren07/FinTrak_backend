import Groq from "groq-sdk";

const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";

let groqClient = null;

function readGroqApiKey() {
  return String(process.env.GROQ_API_KEY || "").trim();
}

export function hasGroqConfig() {
  return Boolean(readGroqApiKey());
}

export function getGroqModel() {
  return String(process.env.GROQ_MODEL || "").trim() || DEFAULT_GROQ_MODEL;
}

export function getGroqClient() {
  const apiKey = readGroqApiKey();

  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured");
  }

  if (!groqClient) {
    groqClient = new Groq({
      apiKey,
    });
  }

  return groqClient;
}
