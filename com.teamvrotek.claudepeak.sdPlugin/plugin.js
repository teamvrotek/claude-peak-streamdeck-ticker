// Claude Peak Monitor - Stream Deck plugin (SDK v3)
// Shows peak/off-peak status and countdown to next change.

import streamDeck, { SingletonAction } from "@elgato/streamdeck";
import https from "https";
import http from "http";
import os from "os";
import { execFile } from "child_process";
import { renderButton, renderError } from "./renderer.js";

const isMac = os.platform() === "darwin";

// -- Peak hours detection via promoclock.co --
let peakStatus = null;

function fetchPeakStatus() {
    https.get("https://promoclock.co/api/status", (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
            try {
                const data = JSON.parse(body);
                peakStatus = {
                    isPeak: data.isPeak,
                    minutesUntilChange: data.minutesUntilChange || 0,
                    nextChange: data.nextChange,
                    label: data.label || "",
                    fetchedAt: Date.now(),
                };
            } catch {
                streamDeck.logger.error("Failed to parse peak status");
            }
        });
    }).on("error", (err) => {
        streamDeck.logger.error("Failed to fetch peak status:", err.message);
    });
}

fetchPeakStatus();
setInterval(fetchPeakStatus, 5 * 60 * 1000);

// Compute live countdown from the last fetched data
function getLiveCountdown() {
    if (!peakStatus) return null;
    const elapsed = Math.floor((Date.now() - peakStatus.fetchedAt) / 60000);
    const remaining = Math.max(0, peakStatus.minutesUntilChange - elapsed);
    return {
        isPeak: peakStatus.isPeak,
        minutesUntilChange: remaining,
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

function getSettings(raw) {
    return {
        colorTheme: raw.colorTheme || "claude",
        pollInterval: parseInt(raw.pollInterval) || 30,
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
            await action.setImage(renderError(settings.colorTheme, "..."));
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
                    label: live ? live.label : "Fetching...",
                },
            });
        }
    }
}

// Register and connect
streamDeck.actions.registerAction(new PeakMonitor());
streamDeck.connect();
