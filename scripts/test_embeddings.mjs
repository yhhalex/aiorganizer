import { readFileSync } from "node:fs";

const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;

const examples = [
  {
    id: "A1",
    group: "anchor",
    text: "Virtual memory lets a system use disk space as an extension of RAM."
  },
  {
    id: "A2",
    group: "similar",
    text: "Virtual memory allows the computer to extend memory using secondary storage."
  },
  {
    id: "B1",
    group: "related",
    text: "Paging divides memory into fixed-size pages."
  },
  {
    id: "B2",
    group: "related",
    text: "Operating systems manage memory using techniques like paging and segmentation."
  },
  {
    id: "C1",
    group: "unrelated",
    text: "Linear regression estimates relationships between variables."
  },
  {
    id: "C2",
    group: "unrelated",
    text: "A database index improves query speed."
  }
];

function loadEnvFile(path) {
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#")) continue;
      const [name, ...valueParts] = line.split("=");
      if (name && valueParts.length && !process.env[name]) {
        process.env[name] = valueParts.join("=").trim();
      }
    }
  } catch {
    // The variable can also come from the shell environment.
  }
}

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function createEmbeddings(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  assert(apiKey, "OPENAI_API_KEY is required. Add it to .env.local or the shell environment.");

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      dimensions: DIMENSIONS,
      encoding_format: "float"
    })
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error?.message || "OpenAI embedding request failed.");
  }

  return payload.data
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.embedding);
}

function scoreAgainstAnchor(embeddings) {
  const anchor = embeddings[0];
  return examples.slice(1).map((example, index) => ({
    id: example.id,
    group: example.group,
    score: cosineSimilarity(anchor, embeddings[index + 1])
  }));
}

async function main() {
  loadEnvFile(".env.local");

  const embeddings = await createEmbeddings(examples.map((example) => example.text));

  assert(embeddings.length === examples.length, "Expected one vector per input text.");
  embeddings.forEach((embedding, index) => {
    assert(Array.isArray(embedding), `${examples[index].id} did not return a numeric vector.`);
    assert(embedding.length === DIMENSIONS, `${examples[index].id} vector dimension should be ${DIMENSIONS}.`);
    assert(embedding.every((value) => Number.isFinite(value)), `${examples[index].id} vector has a non-numeric value.`);
  });

  const scores = scoreAgainstAnchor(embeddings);
  const similarScore = scores.find((entry) => entry.id === "A2").score;
  const relatedScores = scores.filter((entry) => entry.group === "related").map((entry) => entry.score);
  const unrelatedScores = scores.filter((entry) => entry.group === "unrelated").map((entry) => entry.score);
  const highestRelated = Math.max(...relatedScores);
  const highestUnrelated = Math.max(...unrelatedScores);

  assert(
    similarScore === Math.max(...scores.map((entry) => entry.score)),
    "A1 should be closest to A2."
  );
  assert(
    average(relatedScores) > average(unrelatedScores),
    "A1 should be closer to related memory/OS texts than unrelated texts on average."
  );
  assert(
    highestRelated > highestUnrelated,
    "At least one related memory/OS text should outrank all unrelated texts."
  );

  console.log("Embedding similarity ranking");
  scores
    .sort((left, right) => right.score - left.score)
    .forEach((entry) => {
      console.log(`${entry.id} ${entry.group.padEnd(9)} ${entry.score.toFixed(4)}`);
    });
  console.log("PASS: similar texts are closer than related, and related texts outrank unrelated texts.");
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
