import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./bmw-auth.js";
import { fetchTelematicData } from "./bmw_show_api_data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TOKEN_FILE = path.join(__dirname, "bmw_tokens.json");
const INDEX_HTML = path.join(__dirname, "public", "index.html");

function readTokenStatus() {
  if (!fs.existsSync(TOKEN_FILE)) {
    return { hasToken: false, tokenValid: false, tokenExpiresAt: null };
  }
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    const hasToken = Boolean(tokens.access_token || tokens.refresh_token);
    const tokenValid = Boolean(tokens.access_token && Date.now() < (tokens.expires_at || 0));
    return {
      hasToken,
      tokenValid,
      tokenExpiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null
    };
  } catch {
    return { hasToken: false, tokenValid: false, tokenExpiresAt: null };
  }
}

function buildDemoData(vin) {
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 18 * 60 * 1000).toISOString();
  return {
    vin: vin || "WBA00000000000000",
    fetchedAt: now,
    isDemo: true,
    telematicData: {
      "vehicle.drivetrain.fuelSystem.remainingFuel": { value: 38.4, unit: "l", timestamp: earlier },
      "vehicle.drivetrain.fuelSystem.level": { value: 64, unit: "%", timestamp: earlier },
      "vehicle.drivetrain.fuelSystem.tankCapacity": { value: 60, unit: "l", timestamp: earlier },
      "vehicle.drivetrain.totalRemainingRange": { value: 540, unit: "km", timestamp: earlier },
      "vehicle.vehicle.travelledDistance": { value: 142860, unit: "km", timestamp: earlier },
      "vehicle.cabin.door.status": { value: null, unit: null, timestamp: null },
      "vehicle.cabin.door.row1.driver.isOpen": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.door.row1.passenger.isOpen": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.door.row2.driver.isOpen": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.door.row2.passenger.isOpen": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.body.trunk.isOpen": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.body.hood.isOpen": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.window.row1.driver.status": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.window.row1.passenger.status": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.window.row2.driver.status": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.window.row2.passenger.status": { value: "CLOSED", unit: null, timestamp: earlier },
      "vehicle.cabin.infotainment.navigation.currentLocation.latitude": { value: "48.17710", unit: "degrees", timestamp: earlier },
      "vehicle.cabin.infotainment.navigation.currentLocation.longitude": { value: "11.55620", unit: "degrees", timestamp: earlier },
      "vehicle.cabin.infotainment.navigation.currentLocation.heading": { value: "155", unit: "degrees", timestamp: earlier },
      "vehicle.status.serviceDistance.next": { value: "14000", unit: null, timestamp: earlier },
      "vehicle.status.conditionBasedServices": {
        value: JSON.stringify([
          { date: "2027-11", id: 1, messageType: "CBS", status: "OK", title: "Engine oil", text: "-", unitOfLengthRemaining: "14000" },
          { date: "2027-11", id: 3, messageType: "CBS", status: "OK", title: "Brake fluid", text: "-", unitOfLengthRemaining: "-" },
          { date: "2028-04", id: 32, messageType: "CBS", status: "OK", title: "Statutory vehicle inspection", text: "-", unitOfLengthRemaining: "-" },
          { date: "2029-11", id: 100, messageType: "CBS", status: "OK", title: "Vehicle check", text: "-", unitOfLengthRemaining: "40000" }
        ]),
        unit: null,
        timestamp: earlier
      },
      "vehicle.vehicle.averageSpeed": { value: 58.2, unit: "km/h", timestamp: earlier },
      "vehicle.drivetrain.fuelSystem.averageConsumption": { value: 6.8, unit: "l/100km", timestamp: earlier }
    }
  };
}

function formatFileTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "_" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && reqUrl.pathname === "/") {
    try {
      const html = fs.readFileSync(INDEX_HTML, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      sendJson(res, 500, { error: `Dashboard HTML konnte nicht geladen werden: ${err.message}` });
    }
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/config") {
    try {
      const config = loadConfig();
      const tokenStatus = readTokenStatus();
      sendJson(res, 200, {
        clientId: config.CLIENT_ID,
        vin: config.VIN || "",
        ...tokenStatus
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/demo") {
    let vin = "";
    try {
      vin = loadConfig().VIN || "";
    } catch {}
    sendJson(res, 200, buildDemoData(reqUrl.searchParams.get("vin") || vin));
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/telematic") {
    const tokenStatus = readTokenStatus();
    if (!tokenStatus.hasToken) {
      sendJson(res, 401, {
        error: "Noch kein BMW-Token vorhanden. Bitte zuerst im Terminal 'npm run auth' (oder 'node bmw-auth.js') ausführen und den Browser-Login bestätigen."
      });
      return;
    }
    try {
      const vin = reqUrl.searchParams.get("vin") || undefined;
      const data = await fetchTelematicData({ vin });
      const savedFile = `${data.vin}_${formatFileTimestamp()}.json`;
      fs.writeFileSync(path.join(__dirname, savedFile), JSON.stringify(data, null, 2), "utf8");
      sendJson(res, 200, { ...data, savedFile });
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Nicht gefunden" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`BMW CarData Dashboard läuft auf http://127.0.0.1:${PORT}`);
});
