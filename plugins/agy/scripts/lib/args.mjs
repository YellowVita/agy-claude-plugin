// SPDX-License-Identifier: Apache-2.0
// Portions adapted from the OpenAI Codex Plugin for Claude Code:
// https://github.com/openai/codex-plugin-cc
// Copyright 2026 OpenAI
// Modifications Copyright 2026 Antigravity Plugin Contributors.

function splitRawAtDelimiter(raw) {
  let quote = null;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (escaping) {
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character !== "-" || raw[index + 1] !== "-") {
      continue;
    }

    const before = index === 0 ? " " : raw[index - 1];
    const after = index + 2 >= raw.length ? " " : raw[index + 2];
    if (/\s/.test(before) && /\s/.test(after)) {
      return {
        prefix: raw.slice(0, index).trim(),
        prompt: raw.slice(index + 2).replace(/^\s+/, "")
      };
    }
  }

  return null;
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Unterminated quote in command arguments.");
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeCommandArgv(argv, config = {}) {
  const tokens = [];
  let preservedPrompt = null;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index] ?? "");
    if (!raw) {
      continue;
    }

    const delimited = splitRawAtDelimiter(raw);
    if (delimited) {
      tokens.push(...splitRawArgumentString(delimited.prefix));
      preservedPrompt = delimited.prompt;
      for (const remaining of argv.slice(index + 1)) {
        if (remaining) {
          preservedPrompt += `${preservedPrompt ? " " : ""}${remaining}`;
        }
      }
      break;
    }

    const isForcedSingleRawArgument = config.splitSingleRawArgument && argv.length === 1 && /\s/.test(raw);
    const isRawCommandArgument =
      isForcedSingleRawArgument || (index === argv.length - 1 && /^\s*-/.test(raw) && /\s/.test(raw));
    if (isRawCommandArgument) {
      tokens.push(...splitRawArgumentString(raw));
    } else {
      tokens.push(raw);
    }
  }

  if (preservedPrompt !== null) {
    tokens.push("--", preservedPrompt);
  }
  return tokens;
}

export function parseCommandArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  const tokens = normalizeCommandArgv(argv, config);
  let parsingOptions = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!parsingOptions) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      parsingOptions = false;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      if (!config.allowInterspersedOptions) {
        parsingOptions = false;
      }
      positionals.push(token);
      continue;
    }

    let rawKey;
    let inlineValue;
    let displayKey;
    if (token.startsWith("--")) {
      [rawKey, inlineValue] = token.slice(2).split("=", 2);
      displayKey = `--${rawKey}`;
    } else {
      rawKey = token.slice(1);
      displayKey = `-${rawKey}`;
    }
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (!valueOptions.has(key)) {
      throw new Error(`Unknown option: ${displayKey}. Use -- before task text that starts with a dash.`);
    }

    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || value === "--") {
      throw new Error(`Missing value for ${displayKey}.`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    if (repeatableOptions.has(key)) {
      options[key] = [...(options[key] ?? []), value];
    } else {
      options[key] = value;
    }
  }

  return { options, positionals };
}
