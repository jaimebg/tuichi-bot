const fs = require("fs");
const path = require("path");
const { log } = require("../logger");
const { normalizeWhitespace } = require("../utils/text");

function readTextFile(filePath, label) {
    const resolved = path.resolve(filePath);
    try {
        return fs.readFileSync(resolved, "utf8");
    } catch (err) {
        log("error", `Unable to read ${label} file ${resolved}: ${err.message}`);
        process.exit(1);
    }
}

function loadGreetings(filePath) {
    const contents = readTextFile(filePath, "greetings");
    const messages = contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (!messages.length) {
        log("error", "Greeting file must contain at least one message.");
        process.exit(1);
    }
    return messages;
}

function loadPersona(filePath) {
    const contents = readTextFile(filePath, "persona");
    const persona = normalizeWhitespace(contents);
    if (!persona) {
        log("error", "Persona file cannot be empty.");
        process.exit(1);
    }
    return persona;
}

function loadLore(filePath) {
    const contents = readTextFile(filePath, "lore");
    const lore = normalizeWhitespace(contents);
    if (!lore) {
        log("warn", "Lore file is empty; adventures will be generic.");
        return "";
    }
    return lore;
}

function loadAliases(filePath) {
    const contents = readTextFile(filePath, "aliases");
    const aliases = {};
    contents.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
            const [username, alias] = trimmed.split(":").map((s) => s.trim());
            if (username && alias) {
                aliases[username.toLowerCase()] = alias;
            }
        }
    });
    return aliases;
}

module.exports = {
    readTextFile,
    loadGreetings,
    loadPersona,
    loadLore,
    loadAliases
};
