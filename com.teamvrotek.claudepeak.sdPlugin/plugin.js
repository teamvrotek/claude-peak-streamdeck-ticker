// Claude Peak Monitor - Stream Deck plugin (SDK v3)
// Shows peak/off-peak status and countdown to next change.

import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import https from "https";
import http from "http";
import os from "os";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { renderButton, renderError } from "./renderer.js";

const isMac = os.platform() === "darwin";
const STATUS_URL = "https://promoclock.co/api/status";
const NORMAL_FETCH_INTERVAL_MS = 15 * 60 * 1000;
const MIN_FETCH_INTERVAL_MS = 60 * 1000;
const MAX_ERROR_BACKOFF_MS = 30 * 60 * 1000;
const TRANSITION_FETCH_GRACE_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const DEFAULT_DISPLAY_REFRESH_SECONDS = 30;
const DISPLAY_REFRESH_OPTIONS_SECONDS = new Set([15, 30, 60, 120]);
const PEAK_START_HOUR_UTC = 13;
const PEAK_END_HOUR_UTC = 19;
const CACHE_DIR = path.join(getAppDataDir(), "claude-peak-streamdeck-ticker");
const CACHE_FILE = path.join(CACHE_DIR, "peak-status-cache.json");

// -- Peak hours detection via promoclock.co --
let peakStatus = null;
let fetchTimer = null;
let fetchInFlight = false;
let errorBackoffMs = MIN_FETCH_INTERVAL_MS;

function getAppDataDir() {
    if (os.platform() === "win32") {
        return process.env.APPDATA || os.homedir();
    }

    if (os.platform() === "darwin") {
        return path.join(os.homedir(), "Library", "Application Support");
    }

    return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function toValidMinutes(value) {
    if (value === null || value === undefined || value === "") return null;
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

function toValidTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizePeakStatus(data, fetchedAt = Date.now()) {
    if (!data || typeof data.isPeak !== "boolean") {
        throw new Error("Response did not include peak status");
    }

    const minutesUntilChange = toValidMinutes(data.minutesUntilChange);
    const nextChangeAt = toValidTimestamp(data.nextChange);

    if (minutesUntilChange === null && nextChangeAt === null) {
        throw new Error("Response did not include a usable countdown");
    }

    return {
        isPeak: data.isPeak,
        minutesUntilChange,
        nextChange: data.nextChange || null,
        nextChangeAt,
        label: typeof data.label === "string" ? data.label : "",
        fetchedAt,
    };
}

function isWeekdayUtc(date) {
    const day = date.getUTCDay();
    return day >= 1 && day <= 5;
}

function getUtcDateAtHour(date, hour) {
    return new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        hour,
        0,
        0,
        0
    ));
}

function getNextWeekdayStartUtc(date) {
    const next = getUtcDateAtHour(date, PEAK_START_HOUR_UTC);
    next.setUTCDate(next.getUTCDate() + 1);

    while (!isWeekdayUtc(next)) {
        next.setUTCDate(next.getUTCDate() + 1);
    }

    return next;
}

function estimatePeakStatus(fetchedAt = Date.now()) {
    const now = new Date(fetchedAt);
    const peakStart = getUtcDateAtHour(now, PEAK_START_HOUR_UTC);
    const peakEnd = getUtcDateAtHour(now, PEAK_END_HOUR_UTC);
    const isPeak = isWeekdayUtc(now) && now >= peakStart && now < peakEnd;

    let nextChangeAt;
    if (isPeak) {
        nextChangeAt = peakEnd;
    } else if (isWeekdayUtc(now) && now < peakStart) {
        nextChangeAt = peakStart;
    } else {
        nextChangeAt = getNextWeekdayStartUtc(now);
    }

    return {
        isPeak,
        minutesUntilChange: Math.max(0, Math.ceil((nextChangeAt.getTime() - fetchedAt) / 60000)),
        nextChange: nextChangeAt.toISOString(),
        nextChangeAt: nextChangeAt.getTime(),
        label: "Estimated from weekday peak schedule",
        fetchedAt,
    };
}

function isPeakStatusExpired() {
    return peakStatus && peakStatus.nextChangeAt !== null && peakStatus.nextChangeAt <= Date.now();
}

function useEstimatedStatusIfNeeded() {
    if (!peakStatus || isPeakStatusExpired()) {
        peakStatus = estimatePeakStatus();
    }
}

function loadPeakStatusCache() {
    try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
        const fetchedAt = Number.isFinite(Number(cached.fetchedAt)) ? Number(cached.fetchedAt) : Date.now();
        peakStatus = normalizePeakStatus(cached, fetchedAt);
    } catch (err) {
        if (err.code !== "ENOENT") {
            streamDeck.logger.error("Failed to load peak status cache:", err.message);
        }
    }
}

function savePeakStatusCache(status) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            isPeak: status.isPeak,
            minutesUntilChange: status.minutesUntilChange,
            nextChange: status.nextChange,
            label: status.label,
            fetchedAt: status.fetchedAt,
        }));
    } catch (err) {
        streamDeck.logger.error("Failed to save peak status cache:", err.message);
    }
}

function getRetryAfterMs(headerValue) {
    if (!headerValue) return null;

    const seconds = Number(headerValue);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const retryAt = Date.parse(headerValue);
    if (Number.isFinite(retryAt)) {
        return Math.max(0, retryAt - Date.now());
    }

    return null;
}

function getRetryAfterFromBodyMs(body) {
    try {
        const data = JSON.parse(body);
        return getRetryAfterMs(data.retryAfter);
    } catch {
        return null;
    }
}

function getNextSuccessDelay(status) {
    if (status.nextChangeAt !== null) {
        const transitionDelay = status.nextChangeAt - Date.now() + TRANSITION_FETCH_GRACE_MS;
        if (transitionDelay > 0) {
            return Math.max(MIN_FETCH_INTERVAL_MS, Math.min(NORMAL_FETCH_INTERVAL_MS, transitionDelay));
        }
    }

    return NORMAL_FETCH_INTERVAL_MS;
}

function schedulePeakStatusFetch(delayMs) {
    if (fetchTimer) {
        clearTimeout(fetchTimer);
    }

    fetchTimer = setTimeout(() => {
        fetchTimer = null;
        fetchPeakStatus();
    }, Math.max(MIN_FETCH_INTERVAL_MS, delayMs));
}

function scheduleErrorRetry(delayMs = errorBackoffMs) {
    schedulePeakStatusFetch(delayMs);
    errorBackoffMs = Math.min(errorBackoffMs * 2, MAX_ERROR_BACKOFF_MS);
}

function fetchPeakStatus() {
    if (fetchInFlight) return;
    fetchInFlight = true;

    const req = https.get(STATUS_URL, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                const retryAfterMs = getRetryAfterMs(res.headers["retry-after"]) || getRetryAfterFromBodyMs(body);
                const retryDelay = Math.max(retryAfterMs || 0, errorBackoffMs);
                streamDeck.logger.error(`Peak status fetch failed with HTTP ${res.statusCode}`);
                useEstimatedStatusIfNeeded();
                fetchInFlight = false;
                scheduleErrorRetry(retryDelay);
                return;
            }

            try {
                const data = JSON.parse(body);
                peakStatus = normalizePeakStatus(data);
                savePeakStatusCache(peakStatus);
                errorBackoffMs = MIN_FETCH_INTERVAL_MS;
                schedulePeakStatusFetch(getNextSuccessDelay(peakStatus));
            } catch (err) {
                streamDeck.logger.error("Failed to parse peak status:", err.message);
                useEstimatedStatusIfNeeded();
                scheduleErrorRetry();
            }
            fetchInFlight = false;
        });
    }).on("error", (err) => {
        streamDeck.logger.error("Failed to fetch peak status:", err.message);
        useEstimatedStatusIfNeeded();
        fetchInFlight = false;
        scheduleErrorRetry();
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error("Request timed out"));
    });
}

loadPeakStatusCache();
useEstimatedStatusIfNeeded();
fetchPeakStatus();

// Compute live countdown from the last fetched data
function getLiveCountdown() {
    if (!peakStatus) return null;
    let remaining = null;

    if (peakStatus.nextChangeAt !== null) {
        remaining = Math.ceil((peakStatus.nextChangeAt - Date.now()) / 60000);
    } else if (peakStatus.minutesUntilChange !== null) {
        const elapsed = Math.floor((Date.now() - peakStatus.fetchedAt) / 60000);
        remaining = peakStatus.minutesUntilChange - elapsed;
    }

    return {
        isPeak: peakStatus.isPeak,
        minutesUntilChange: Math.max(0, remaining),
        label: peakStatus.label,
    };
}

// -- Helpers --

function openUrl(url) {
    if (isMac) {
        execFile("open", [url], (err) => {
            if (err) streamDeck.logger.error("Failed to open browser:", err.message);
        });
    } else {
        execFile("cmd", ["/c", "start", url], (err) => {
            if (err) streamDeck.logger.error("Failed to open browser:", err.message);
        });
    }
}

function launchClaudeSpend() {
    if (isMac) {
        execFile("osascript", ["-e",
            'tell application "Terminal"\n'
            + '  if (count of windows) is 0 then\n'
            + '    do script "npx claude-spend"\n'
            + '  else\n'
            + '    do script "npx claude-spend" in front window\n'
            + '  end if\n'
            + '  activate\n'
            + 'end tell'
        ], (err) => {
            if (err) streamDeck.logger.error("Failed to launch claude-spend:", err.message);
        });
    } else {
        execFile("cmd", ["/c", "start", "cmd", "/k", "npx claude-spend"], (err) => {
            if (err) streamDeck.logger.error("Failed to launch claude-spend:", err.message);
        });
    }
}

function getSettings(raw = {}) {
    raw = raw || {};
    const displayRefresh = parseInt(raw.pollInterval, 10);

    return {
        colorTheme: raw.colorTheme || "claude",
        pollInterval: DISPLAY_REFRESH_OPTIONS_SECONDS.has(displayRefresh)
            ? displayRefresh
            : DEFAULT_DISPLAY_REFRESH_SECONDS,
    };
}

// -- Polling state --
const pollingIntervals = {};

function startPolling(action, settings) {
    const id = action.id;
    stopPolling(id);
    refreshButton(action, settings);

    const interval = settings.pollInterval * 1000;
    pollingIntervals[id] = setInterval(() => {
        refreshButton(action, settings);
    }, interval);
}

function stopPolling(id) {
    if (pollingIntervals[id]) {
        clearInterval(pollingIntervals[id]);
        delete pollingIntervals[id];
    }
}

async function refreshButton(action, settings) {
    try {
        const live = getLiveCountdown();
        if (!live) {
            await action.setImage(renderError(settings.colorTheme, "loading"));
            return;
        }
        const image = renderButton({
            isPeak: live.isPeak,
            minutesUntilChange: live.minutesUntilChange,
            colorTheme: settings.colorTheme,
        });
        await action.setImage(image);
    } catch (err) {
        streamDeck.logger.error("Refresh error:", err.message);
        await action.setImage(renderError(settings.colorTheme, "--"));
    }
}

// -- Action --

class PeakMonitor extends SingletonAction {
    manifestId = "com.teamvrotek.claudepeak.monitor";
    async onWillAppear(ev) {
        const settings = getSettings(ev.payload.settings || {});
        startPolling(ev.action, settings);
    }

    async onWillDisappear(ev) {
        stopPolling(ev.action.id);
    }

    async onDidReceiveSettings(ev) {
        const settings = getSettings(ev.payload.settings);
        startPolling(ev.action, settings);
    }

    async onKeyDown(ev) {
        const settings = getSettings(ev.payload.settings || {});

        // Check if claude-spend is already running on localhost:3456
        const req = http.get("http://127.0.0.1:3456/", (res) => {
            res.resume();
            openUrl("http://127.0.0.1:3456/");
        });

        req.on("error", () => {
            launchClaudeSpend();
        });

        req.setTimeout(1000, () => {
            req.destroy();
        });

        refreshButton(ev.action, settings);
    }

    async onSendToPlugin(ev) {
        if (!ev.payload) return;

        if (ev.payload.type === "getStatus") {
            const live = getLiveCountdown();
            await streamDeck.ui.sendToPropertyInspector({
                type: "statusUpdate",
                data: {
                    isPeak: live ? live.isPeak : null,
                    minutesUntilChange: live ? live.minutesUntilChange : null,
                    label: live ? live.label : "Loading...",
                },
            });
        }
    }
}

// Register and connect
streamDeck.actions.registerAction(new PeakMonitor());
streamDeck.connect();
