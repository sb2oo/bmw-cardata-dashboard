import { fileURLToPath } from "node:url";
import { getValidToken, loadConfig } from "./bmw-auth.js";

const API_BASE = "https://api-cardata.bmwgroup.com";
const DEFAULT_DESCRIPTORS = [
  "vehicle.drivetrain.fuelSystem.remainingFuel",
  "vehicle.drivetrain.fuelSystem.level",
  "vehicle.drivetrain.totalRemainingRange",
  "vehicle.vehicle.travelledDistance",
  "vehicle.cabin.door.status",
  "vehicle.cabin.door.row1.driver.isOpen",
  "vehicle.cabin.door.row1.passenger.isOpen",
  "vehicle.cabin.door.row2.driver.isOpen",
  "vehicle.cabin.door.row2.passenger.isOpen",
  "vehicle.body.trunk.isOpen",
  "vehicle.body.hood.isOpen",
  "vehicle.cabin.window.row1.driver.status",
  "vehicle.cabin.window.row1.passenger.status",
  "vehicle.cabin.window.row2.driver.status",
  "vehicle.cabin.window.row2.passenger.status",
  "vehicle.cabin.infotainment.navigation.currentLocation.latitude",
  "vehicle.cabin.infotainment.navigation.currentLocation.longitude",
  "vehicle.cabin.infotainment.navigation.currentLocation.heading",
  "vehicle.status.serviceDistance.next",
  "vehicle.status.conditionBasedServices"
];

let cachedContainerId = null;

async function resolveContainerId(accessToken, configuredId) {
  if (configuredId) return configuredId;
  if (cachedContainerId) return cachedContainerId;

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "x-version": "v1",
    "Accept": "application/json"
  };

  const listRes = await fetch(`${API_BASE}/customers/containers`, { headers });
  if (!listRes.ok) {
    throw new Error(`Container-Abruf fehlgeschlagen (HTTP ${listRes.status}): ${await listRes.text()}`);
  }
  const listData = await listRes.json();
  const active = (listData.containers || []).find((c) => c.state === "ACTIVE") || listData.containers?.[0];
  if (active?.containerId) {
    cachedContainerId = active.containerId;
    return cachedContainerId;
  }

  const createRes = await fetch(`${API_BASE}/customers/containers`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "BMW Dashboard",
      purpose: "Fuel and Vehicle Telemetry",
      technicalDescriptors: DEFAULT_DESCRIPTORS
    })
  });
  if (!createRes.ok) {
    throw new Error(`Container-Erstellung fehlgeschlagen (HTTP ${createRes.status}): ${await createRes.text()}`);
  }
  const created = await createRes.json();
  cachedContainerId = created.containerId;
  return cachedContainerId;
}

/**
 * Ruft die aktuellen BMW CarData Telematik-Daten für die konfigurierte VIN ab.
 */
export async function fetchTelematicData(options = {}) {
  const config = loadConfig();
  const vin = (options.vin || config.VIN || "").trim();
  if (!vin) {
    throw new Error("VIN fehlt in secret.cfg (z. B. VIN=WBA...)");
  }

  const tokens = await getValidToken();
  const containerId = await resolveContainerId(tokens.access_token, options.containerId || config.CONTAINER_ID);
  const url = `${API_BASE}/customers/vehicles/${encodeURIComponent(vin)}/telematicData?containerId=${encodeURIComponent(containerId)}`;

  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${tokens.access_token}`,
      "x-version": "v1",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return {
    vin,
    containerId,
    fetchedAt: new Date().toISOString(),
    telematicData: data.telematicData ?? data
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchTelematicData()
    .then((result) => {
      console.log(`VIN: ${result.vin} | Container: ${result.containerId} | Abgerufen: ${result.fetchedAt}`);
      console.log(JSON.stringify(result.telematicData, null, 2));
    })
    .catch((err) => {
      console.error("[FEHLER]", err.message);
      process.exit(1);
    });
}
