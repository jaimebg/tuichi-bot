const fs = require("fs");
const path = require("path");
const { log } = require("../logger");

class DataPersistence {
    constructor(config) {
        this.enabled = config?.enabled ?? false;
        this.dataDir = config?.dataDir || path.join(__dirname, "..", "..", "data");
        this.files = config?.files || {};
        this.saveIntervalMs = (config?.saveIntervalMinutes || 5) * 60 * 1000;
        this.saveTimer = null;

        if (this.enabled) {
            this.ensureDataDirectory();
        }
    }

    ensureDataDirectory() {
        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
                log("info", `Created data directory: ${this.dataDir}`);
            }
        } catch (err) {
            log("error", `Failed to create data directory: ${err.message}`);
            this.enabled = false;
        }
    }

    getFilePath(fileKey) {
        const fileName = this.files[fileKey];
        return fileName ? path.join(this.dataDir, fileName) : null;
    }

    async saveData(fileKey, data) {
        if (!this.enabled) return;

        const filePath = this.getFilePath(fileKey);
        if (!filePath) {
            log("warn", `No file path configured for key: ${fileKey}`);
            return;
        }

        try {
            const jsonData = JSON.stringify(data, this.jsonReplacer, 2);
            await fs.promises.writeFile(filePath, jsonData, "utf8");
            log("debug", `Saved ${fileKey} data to ${filePath}`);
        } catch (err) {
            log("warn", `Failed to save ${fileKey}: ${err.message}`);
        }
    }

    async loadData(fileKey, defaultValue = null) {
        if (!this.enabled) return defaultValue;

        const filePath = this.getFilePath(fileKey);
        if (!filePath || !fs.existsSync(filePath)) {
            return defaultValue;
        }

        try {
            const jsonData = await fs.promises.readFile(filePath, "utf8");
            const data = JSON.parse(jsonData, this.jsonReviver);
            log("info", `Loaded ${fileKey} data from ${filePath}`);
            return data;
        } catch (err) {
            log("warn", `Failed to load ${fileKey}: ${err.message}`);
            return defaultValue;
        }
    }

    jsonReplacer(key, value) {
        if (value instanceof Map) {
            return {
                __type: "Map",
                __data: Array.from(value.entries())
            };
        }
        if (value instanceof Set) {
            return {
                __type: "Set",
                __data: Array.from(value)
            };
        }
        return value;
    }

    jsonReviver(key, value) {
        if (typeof value === "object" && value !== null) {
            if (value.__type === "Map") {
                return new Map(value.__data);
            }
            if (value.__type === "Set") {
                return new Set(value.__data);
            }
        }
        return value;
    }

    startAutoSave(saveCallback) {
        if (!this.enabled || this.saveTimer) return;

        this.saveTimer = setInterval(() => {
            try {
                saveCallback();
            } catch (err) {
                log("warn", `Auto-save failed: ${err.message}`);
            }
        }, this.saveIntervalMs);

        log("info", `Started auto-save every ${this.saveIntervalMs / 60000} minutes`);
    }

    stopAutoSave() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
            log("info", "Stopped auto-save");
        }
    }
}

module.exports = DataPersistence;
