// Global State Management
let isTracking = false;
let startTime = null;
let timerInterval = null;
let elapsedSeconds = 0;
let watchId = null;

// Tracking coordinates & accumulators
let tripCoords = [];
let totalDistance = 0; // in meters
let totalElevationGain = 0; // in meters
let maxSpeed = 0; // in m/s
let maxIncline = 0; // percentage
let previousFilteredAltitude = null;
let lastSpeedLimit = null;
let speedLimitRoadName = "";

// Diagnostic flags
let pendingUserEvent = false;
let activeAlerts = new Map(); // tracks current active alerts

// Dynamic G-Force Tracker state
let currentAccel = { x: 0, y: 0, z: 0, total: 1.0 }; // standard vert gravity default is 1.0G

// Map variables
let map = null;
let activePolylineGroup = null;
let userMarker = null;
let mapCentered = true;

// Chart variables
let telemetryChart = null;

// Settings & Config
let settings = {
  trackingProfile: 'high-res', // 'high-res', 'standard', 'distance'
  keepAwake: true,
  autoStart: false,
  autoStartThreshold: 10, // km/h
  units: 'metric' // 'metric' or 'imperial'
};

// Wake Lock reference
let wakeLock = null;

// OpenStreetMap speed limit checking throttling
let lastOsmQueryTime = 0;
const OSM_QUERY_INTERVAL_MS = 10000; // query every 10s
let lastOsmCoords = { lat: 0, lon: 0 };

// Auto-start counter variables
let autoStartTriggerPoints = 0;

// Incline EMA smoothing factor
const ALTITUDE_SMOOTHING_FACTOR = 0.15; 

// IndexedDB Setup
const DB_NAME = 'MotionTrackerDB';
const DB_VERSION = 1;
const STORE_NAME = 'trips';
let db = null;

function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    
    request.onerror = (e) => {
      console.error('IndexedDB initialization failed:', e.target.error);
      reject(e.target.error);
    };
  });
}

// -------------------------------------------------------------
// Database Utilities
// -------------------------------------------------------------
function saveTripToDB(trip) {
  return new Promise((resolve, reject) => {
    if (!db) return reject('DB not open');
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(trip);
    
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

function getAllTripsFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = (e) => {
      const trips = e.target.result || [];
      trips.sort((a, b) => b.id - a.id);
      resolve(trips);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

function deleteTripFromDB(id) {
  return new Promise((resolve, reject) => {
    if (!db) return reject('DB not open');
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(Number(id));
    
    request.onsuccess = () => resolve(true);
    request.onerror = (e) => reject(e.target.error);
  });
}

// -------------------------------------------------------------
// Screen Wake Lock API Management
// -------------------------------------------------------------
async function requestWakeLock() {
  if (!settings.keepAwake || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    updateWakeStatus(true);
    
    wakeLock.addEventListener('release', () => {
      updateWakeStatus(false);
    });
  } catch (err) {
    console.warn(`Wake Lock request failed: ${err.name}, ${err.message}`);
    updateWakeStatus(false);
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release();
    wakeLock = null;
    updateWakeStatus(false);
  }
}

document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible') {
    await requestWakeLock();
  }
});

function updateWakeStatus(isActive) {
  const badge = document.getElementById('wake-status');
  const text = badge.querySelector('.status-text');
  if (isActive) {
    badge.className = 'status-tag online';
    text.textContent = 'SCREEN ACTIVE';
  } else {
    badge.className = 'status-tag offline';
    text.textContent = 'SCREEN SLEEPABLE';
  }
}

// -------------------------------------------------------------
// Math and Calculations
// -------------------------------------------------------------
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return [
    hrs.toString().padStart(2, '0'),
    mins.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0')
  ].join(':');
}

function convertSpeed(mps) {
  if (settings.units === 'imperial') {
    return mps * 2.23694; // to mph
  }
  return mps * 3.6; // to km/h
}

function convertDistance(meters) {
  if (settings.units === 'imperial') {
    return meters * 0.000621371; // to miles
  }
  return meters / 1000; // to km
}

function convertElevation(meters) {
  if (settings.units === 'imperial') {
    return meters * 3.28084; // to feet
  }
  return meters; // meters
}

// -------------------------------------------------------------
// OpenStreetMap Overpass Speed Limit Query
// -------------------------------------------------------------
async function fetchRoadSpeedLimit(lat, lon) {
  const now = Date.now();
  if (now - lastOsmQueryTime < OSM_QUERY_INTERVAL_MS) return;
  
  const distMoved = getDistance(lastOsmCoords.lat, lastOsmCoords.lon, lat, lon);
  if (distMoved < 15 && lastOsmQueryTime !== 0) return;

  lastOsmQueryTime = now;
  lastOsmCoords = { lat, lon };

  const query = `[out:json];
    way(around:30, ${lat}, ${lon})[highway];
    out tags;`;

  try {
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('OSM Server error');
    
    const data = await response.json();
    if (data && data.elements && data.elements.length > 0) {
      const ways = data.elements;
      let targetWay = ways[0];
      
      const withSpeed = ways.find(w => w.tags && w.tags.maxspeed);
      if (withSpeed) {
        targetWay = withSpeed;
      }
      
      const tags = targetWay.tags || {};
      speedLimitRoadName = tags.name || tags.ref || "Unnamed Road";
      
      if (tags.maxspeed) {
        let rawLimit = tags.maxspeed;
        let parsedLimit = parseInt(rawLimit, 10);
        
        if (rawLimit.includes('mph')) {
          if (settings.units === 'metric') {
            lastSpeedLimit = Math.round(parsedLimit * 1.60934);
          } else {
            lastSpeedLimit = parsedLimit;
          }
        } else {
          if (settings.units === 'imperial') {
            lastSpeedLimit = Math.round(parsedLimit * 0.621371);
          } else {
            lastSpeedLimit = parsedLimit;
          }
        }
      } else if (tags.highway) {
        const highwayTypes = {
          motorway: 110,
          primary: 80,
          secondary: 70,
          tertiary: 50,
          residential: 30,
          living_street: 15,
          service: 20
        };
        let kmhLimit = highwayTypes[tags.highway] || 50;
        
        if (settings.units === 'imperial') {
          lastSpeedLimit = Math.round(kmhLimit * 0.621371);
        } else {
          lastSpeedLimit = kmhLimit;
        }
      } else {
        lastSpeedLimit = null;
      }
    } else {
      lastSpeedLimit = null;
      speedLimitRoadName = "Unknown Area";
    }
  } catch (err) {
    console.warn("OSM speed limit fetch failed:", err);
  }
}

// -------------------------------------------------------------
// Accelerometer & G-Force Listeners
// -------------------------------------------------------------
function initAccelerometer() {
  if ('DeviceMotionEvent' in window) {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const requestPermissionHandler = () => {
        DeviceMotionEvent.requestPermission()
          .then(permissionState => {
            if (permissionState === 'granted') {
              console.log("DeviceMotion permissions granted on iOS");
              window.removeEventListener('click', requestPermissionHandler);
            }
          })
          .catch(err => console.warn("Permission dialog failed:", err));
      };
      window.addEventListener('click', requestPermissionHandler);
    }

    window.addEventListener('devicemotion', (event) => {
      const acc = event.accelerationIncludingGravity || event.acceleration;
      if (!acc) return;

      let rX = acc.x || 0;
      let rY = acc.y || 0;
      let rZ = acc.z || 0;

      const smoothing = 0.15;
      currentAccel.x = (smoothing * rX) + ((1 - smoothing) * currentAccel.x);
      currentAccel.y = (smoothing * rY) + ((1 - smoothing) * currentAccel.y);
      currentAccel.z = (smoothing * rZ) + ((1 - smoothing) * currentAccel.z);

      const gX = currentAccel.x / 9.80665;
      const gY = currentAccel.y / 9.80665;
      const gZ = currentAccel.z / 9.80665;
      const gTotal = Math.sqrt(gX * gX + gY * gY + gZ * gZ);

      currentAccel.total = gTotal;

      document.getElementById('g-lat').textContent = `${gX.toFixed(2)} G`;
      document.getElementById('g-long').textContent = `${gY.toFixed(2)} G`;
      document.getElementById('g-vert').textContent = `${gZ.toFixed(2)} G`;
      document.getElementById('g-total').textContent = `${gTotal.toFixed(2)} G`;

      const maxGScale = 1.2;
      const displacementMaxPx = 55;

      const deltaX = Math.max(-1, Math.min(1, gX / maxGScale)) * displacementMaxPx;
      const deltaY = Math.max(-1, Math.min(1, -gY / maxGScale)) * displacementMaxPx;

      const dot = document.getElementById('gforce-dot');
      if (dot) {
        dot.style.left = `calc(50% + ${deltaX}px)`;
        dot.style.top = `calc(50% + ${deltaY}px)`;
      }
    });
  } else {
    console.warn("DeviceMotionEvent not supported on this platform.");
    document.getElementById('gforce-panel').style.opacity = '0.5';
  }
}

// -------------------------------------------------------------
// Tracking GPS Updates
// -------------------------------------------------------------
function handleGPSUpdate(position) {
  const coords = position.coords;
  const accuracy = coords.accuracy;
  const currentTimestamp = position.timestamp;

  if (accuracy > 50) {
    updateGPSBadge(false, `LOW ACCURACY (${Math.round(accuracy)}m)`);
    return;
  }

  updateGPSBadge(true, "GPS ACTIVE");

  const currentLat = coords.latitude;
  const currentLon = coords.longitude;
  
  let speedMps = (coords.speed !== null && coords.speed >= 0) ? coords.speed : 0;
  let rawAltitude = coords.altitude !== null ? coords.altitude : 0;
  let filteredAltitude = rawAltitude;
  
  if (coords.altitude !== null) {
    if (previousFilteredAltitude === null) {
      filteredAltitude = rawAltitude;
    } else {
      filteredAltitude = (ALTITUDE_SMOOTHING_FACTOR * rawAltitude) + ((1 - ALTITUDE_SMOOTHING_FACTOR) * previousFilteredAltitude);
    }
  }

  let stepDistance = 0;
  let computedIncline = 0;

  if (tripCoords.length > 0) {
    const lastPt = tripCoords[tripCoords.length - 1];
    stepDistance = getDistance(lastPt.lat, lastPt.lon, currentLat, currentLon);
    const timeDelta = (currentTimestamp - lastPt.time) / 1000;
    
    if ((coords.speed === null || coords.speed <= 0.1) && stepDistance > 1 && timeDelta > 0) {
      speedMps = stepDistance / timeDelta;
    }

    if (isTracking) {
      totalDistance += stepDistance;
      
      if (coords.altitude !== null && previousFilteredAltitude !== null) {
        const altitudeDelta = filteredAltitude - previousFilteredAltitude;
        if (altitudeDelta > 0) {
          totalElevationGain += altitudeDelta;
        }
        
        if (stepDistance > 8) {
          computedIncline = (altitudeDelta / stepDistance) * 100;
          computedIncline = Math.max(-40, Math.min(40, computedIncline));
          if (Math.abs(computedIncline) > Math.abs(maxIncline)) {
            maxIncline = computedIncline;
          }
        } else {
          computedIncline = lastPt.incline || 0;
        }
      }
    }
  }

  if (speedMps > maxSpeed && isTracking) {
    maxSpeed = speedMps;
  }

  fetchRoadSpeedLimit(currentLat, currentLon);

  // Auto Diagnostics Processing (Phone-Sensor-Only)
  let diagnosticAlert = "";
  if (isTracking) {
    diagnosticAlert = runAutoDiagnostics(speedMps, computedIncline, currentTimestamp);
  }

  let eventFlag = "";
  if (pendingUserEvent) {
    eventFlag = "USER_MARKED";
    pendingUserEvent = false;
    triggerUIConfirmation("EVENT MARKED successfully at GPS coordinate.");
  }

  // Compile coordinate log packet
  const currentWaypoint = {
    lat: currentLat,
    lon: currentLon,
    time: currentTimestamp,
    speed: speedMps,
    altitude: filteredAltitude,
    rawAltitude: rawAltitude,
    incline: computedIncline,
    speedLimit: lastSpeedLimit,
    roadName: speedLimitRoadName,
    gx: currentAccel.x / 9.80665,
    gy: currentAccel.y / 9.80665,
    gz: currentAccel.z / 9.80665,
    gtotal: currentAccel.total,
    userEvent: eventFlag,
    diagnosticAlert: diagnosticAlert
  };

  previousFilteredAltitude = filteredAltitude;

  updateLiveUI(currentWaypoint);

  if (isTracking) {
    if (shouldLogPoint(currentWaypoint)) {
      tripCoords.push(currentWaypoint);
      addPointToMap(currentWaypoint);
      addPointToCharts(currentWaypoint);
      
      // Update UI alerts list with any triggered flags
      updateAlertsUI();
    }
  } else {
    handleAutoStartCheck(speedMps);
  }
}

// -------------------------------------------------------------
// Auto-Diagnostics Logic (Sliding Window Analysis)
// -------------------------------------------------------------
function runAutoDiagnostics(currentSpeedMps, currentIncline, currentTimestamp) {
  if (tripCoords.length < 5) return "";
  
  let flags = [];
  
  // Fetch coordinates recorded in the last 15 seconds
  const fifteenSecsAgo = currentTimestamp - 15000;
  const recentCoords = tripCoords.filter(c => c.time >= fifteenSecsAgo);
  
  if (recentCoords.length >= 3) {
    const firstCoord = recentCoords[0];
    const speedDeltaKmh = (currentSpeedMps - firstCoord.speed) * 3.6;
    
    // Average incline during this sliding window
    const avgIncline = recentCoords.reduce((sum, c) => sum + c.incline, 0) / recentCoords.length;

    // 1. Incline Deceleration (Depletion signature: slowing down while climbing uphill)
    if (avgIncline > 1.8 && speedDeltaKmh < -6.0 && currentSpeedMps > 1.0) {
      // Vehicle has dropped speed by > 6 km/h over the last 15s uphill climb
      flags.push("INCLINE_DECEL");
      activeAlerts.set("INCLINE_DECEL", {
        msg: "PERFORMANCE: Decelerating on incline (Potential battery drain)",
        time: new Date().toLocaleTimeString()
      });
    } else {
      // Remove alert if no longer slowing down or incline flattened
      if (currentIncline < 1.0 || speedDeltaKmh >= 0) {
        activeAlerts.delete("INCLINE_DECEL");
      }
    }

    // 2. Unexpected Propulsion Drop on Flat Terrain (Power loss without full stop)
    if (Math.abs(avgIncline) < 1.0 && speedDeltaKmh < -12.0 && currentSpeedMps > 1.5) {
      // Flat terrain speed drop > 12 km/h over 15s (without stopping)
      flags.push("PROPULSION_DROP");
      activeAlerts.set("PROPULSION_DROP", {
        msg: "PROPULSION: Unexpected power loss on flat terrain",
        time: new Date().toLocaleTimeString()
      });
    } else {
      if (speedDeltaKmh >= 0) {
        activeAlerts.delete("PROPULSION_DROP");
      }
    }
  }

  // 3. Unsafe Speed Delta (Rear-end risk alert)
  if (lastSpeedLimit !== null) {
    const limitMps = settings.units === 'imperial' ? (lastSpeedLimit / 2.23694) : (lastSpeedLimit / 3.6);
    // Alert if traveling at least 40% below speed limit on high-speed roads (> 50 km/h)
    if (limitMps > 13.8 && currentSpeedMps < limitMps * 0.60 && currentSpeedMps > 2.0) {
      flags.push("SPEED_HAZARD");
      activeAlerts.set("SPEED_HAZARD", {
        msg: `SAFETY: Speed is 40%+ below limit on active road (Rear-end risk)`,
        time: new Date().toLocaleTimeString()
      });
    } else {
      activeAlerts.delete("SPEED_HAZARD");
    }
  }

  return flags.join(';');
}

function updateAlertsUI() {
  const panel = document.getElementById('alerts-panel');
  const list = document.getElementById('alerts-list');
  
  if (activeAlerts.size === 0) {
    panel.classList.add('hide');
    return;
  }
  
  panel.classList.remove('hide');
  list.innerHTML = '';
  
  activeAlerts.forEach((val, key) => {
    const item = document.createElement('div');
    item.className = 'alert-item';
    item.innerHTML = `
      <span>${val.msg}</span>
      <span class="alert-timestamp">${val.time}</span>
    `;
    list.appendChild(item);
  });
}

function triggerUIConfirmation(msg) {
  const panel = document.getElementById('alerts-panel');
  const list = document.getElementById('alerts-list');
  
  panel.classList.remove('hide');
  
  const item = document.createElement('div');
  item.className = 'alert-item';
  item.style.borderLeftColor = 'var(--accent-green)';
  item.innerHTML = `
    <span style="color: var(--accent-green); font-weight: 800;">${msg}</span>
    <span class="alert-timestamp">${new Date().toLocaleTimeString()}</span>
  `;
  
  // Prepend to show on top
  list.insertBefore(item, list.firstChild);
  
  // Slide up/fade out notice after 4 seconds
  setTimeout(() => {
    item.remove();
    if (activeAlerts.size === 0 && list.children.length === 0) {
      panel.classList.add('hide');
    }
  }, 4000);
}

// Enforces dynamic logging resolutions
function shouldLogPoint(newPt) {
  if (tripCoords.length === 0) return true;
  
  const lastPt = tripCoords[tripCoords.length - 1];
  const timeDeltaMs = newPt.time - lastPt.time;
  
  switch (settings.trackingProfile) {
    case 'high-res':
      return timeDeltaMs >= 900; 
      
    case 'standard':
      return timeDeltaMs >= 9500;
      
    case 'distance':
      const displacement = getDistance(lastPt.lat, lastPt.lon, newPt.lat, newPt.lon);
      return displacement >= 15;
      
    default:
      return true;
  }
}

function handleGPSFail(error) {
  console.warn("GPS watch failed:", error.message);
  updateGPSBadge(false, "GPS ERROR");
}

function updateGPSBadge(isActive, label) {
  const badge = document.getElementById('gps-status');
  const text = badge.querySelector('.status-text');
  if (isActive) {
    badge.className = 'status-tag online';
    text.textContent = label;
  } else {
    badge.className = 'status-tag offline';
    text.textContent = label;
  }
}

// -------------------------------------------------------------
// Auto-Start Tracking Check
// -------------------------------------------------------------
function handleAutoStartCheck(speedMps) {
  if (!settings.autoStart || isTracking) return;
  
  const currentSpeedKmh = speedMps * 3.6;
  const thresholdKmh = settings.autoStartThreshold;
  
  if (currentSpeedKmh >= thresholdKmh) {
    autoStartTriggerPoints++;
    if (autoStartTriggerPoints >= 3) {
      console.log(`Auto-start triggered at speed: ${currentSpeedKmh.toFixed(1)} km/h`);
      toggleTracking();
    }
  } else {
    autoStartTriggerPoints = 0;
  }
}

// -------------------------------------------------------------
// UI Updates
// -------------------------------------------------------------
function updateLiveUI(pt) {
  const displaySpeed = convertSpeed(pt.speed);
  document.getElementById('current-speed').textContent = Math.round(displaySpeed);

  const maxScale = settings.units === 'imperial' ? 90 : 140;
  const fillPct = Math.min(100, (displaySpeed / maxScale) * 100);
  const offset = 353 - (353 * (fillPct / 100));
  document.getElementById('speed-progress').style.strokeDashoffset = offset;

  const limitBox = document.getElementById('speed-limit-display');
  const warningOverlay = document.getElementById('speeding-warning');
  
  if (pt.speedLimit !== null) {
    limitBox.classList.remove('hide');
    document.getElementById('speed-limit-val').textContent = pt.speedLimit;
    
    if (displaySpeed > pt.speedLimit * 1.05) {
      warningOverlay.classList.remove('hide');
      document.getElementById('speed-progress').style.stroke = 'var(--accent-red)';
    } else {
      warningOverlay.classList.add('hide');
      document.getElementById('speed-progress').style.stroke = 'var(--accent-cyan)';
    }
  } else {
    limitBox.classList.add('hide');
    warningOverlay.classList.add('hide');
    document.getElementById('speed-progress').style.stroke = 'var(--accent-cyan)';
  }

  if (isTracking) {
    const formattedDistance = convertDistance(totalDistance);
    const speedUnit = settings.units === 'imperial' ? 'mph' : 'km/h';
    const distUnit = settings.units === 'imperial' ? 'mi' : 'km';
    const elevUnit = settings.units === 'imperial' ? 'ft' : 'm';

    document.getElementById('stat-distance').innerHTML = `${formattedDistance.toFixed(2)} <span class="sub-unit">${distUnit}</span>`;
    
    const avgSpeedMps = elapsedSeconds > 0 ? (totalDistance / elapsedSeconds) : 0;
    document.getElementById('stat-avg-speed').innerHTML = `${convertSpeed(avgSpeedMps).toFixed(1)} <span class="sub-unit">${speedUnit}</span>`;
    document.getElementById('stat-max-speed').innerHTML = `${convertSpeed(maxSpeed).toFixed(1)} <span class="sub-unit">${speedUnit}</span>`;
    document.getElementById('stat-incline').innerHTML = `${pt.incline.toFixed(1)} <span class="sub-unit">%</span>`;
    document.getElementById('stat-elevation').innerHTML = `${Math.round(convertElevation(totalElevationGain))} <span class="sub-unit">${elevUnit}</span>`;
  }
}

// -------------------------------------------------------------
// Tracking Actions
// -------------------------------------------------------------
async function toggleTracking() {
  const btn = document.getElementById('track-btn');
  const markBtn = document.getElementById('mark-event-btn');
  
  if (!isTracking) {
    isTracking = true;
    startTime = Date.now();
    elapsedSeconds = 0;
    totalDistance = 0;
    totalElevationGain = 0;
    maxSpeed = 0;
    maxIncline = 0;
    tripCoords = [];
    previousFilteredAltitude = null;
    autoStartTriggerPoints = 0;
    activeAlerts.clear();
    document.getElementById('alerts-panel').classList.add('hide');
    
    btn.className = 'btn btn-primary btn-stop';
    btn.innerHTML = `<span class="btn-icon">■</span><span class="btn-text">STOP TRIP</span>`;
    
    // Display Event button during active tracking
    markBtn.style.display = 'flex';

    if (activePolylineGroup) {
      activePolylineGroup.clearLayers();
    }
    
    resetCharts();

    timerInterval = setInterval(() => {
      elapsedSeconds++;
      document.getElementById('stat-duration').textContent = formatDuration(elapsedSeconds);
    }, 1000);

    await requestWakeLock();
    
    console.log(`Trip started under resolution profile: ${settings.trackingProfile}`);
  } else {
    isTracking = false;
    clearInterval(timerInterval);
    releaseWakeLock();
    activeAlerts.clear();
    document.getElementById('alerts-panel').classList.add('hide');
    
    btn.className = 'btn btn-primary btn-start';
    btn.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">START TRIP</span>`;
    
    // Hide event button
    markBtn.style.display = 'none';

    console.log("Trip tracking stopped.");
    
    if (tripCoords.length > 2 && totalDistance > 5) {
      const newTrip = {
        id: startTime,
        date: new Date(startTime).toLocaleString(),
        duration: elapsedSeconds,
        distance: totalDistance,
        avgSpeed: totalDistance / elapsedSeconds,
        maxSpeed: maxSpeed,
        elevationGain: totalElevationGain,
        maxIncline: maxIncline,
        trackingProfile: settings.trackingProfile,
        coords: tripCoords
      };
      
      await saveTripToDB(newTrip);
      await loadTripHistory();
      
      openTripModal(newTrip);
    } else {
      alert("Trip was too short to record.");
    }

    document.getElementById('stat-duration').textContent = "00:00:00";
    document.getElementById('stat-distance').textContent = `0.00 ${settings.units === 'imperial' ? 'mi' : 'km'}`;
    document.getElementById('stat-avg-speed').textContent = `0.0 ${settings.units === 'imperial' ? 'mph' : 'km/h'}`;
    document.getElementById('stat-max-speed').textContent = `0.0 ${settings.units === 'imperial' ? 'mph' : 'km/h'}`;
    document.getElementById('stat-incline').textContent = "0.0 %";
    document.getElementById('stat-elevation').textContent = `0 ${settings.units === 'imperial' ? 'ft' : 'm'}`;
  }
}

// -------------------------------------------------------------
// Interactive Maps (Leaflet.js)
// -------------------------------------------------------------
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([0, 0], 2);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  activePolylineGroup = L.featureGroup().addTo(map);

  const pulseIcon = L.divIcon({
    className: 'custom-pulse-marker',
    html: `<div class="pulse-ring"></div><div class="pulse-dot"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
  
  userMarker = L.marker([0, 0], { icon: pulseIcon }).addTo(map);
  
  const style = document.createElement('style');
  style.innerHTML = `
    .custom-pulse-marker { position: relative; }
    .pulse-ring {
      border: 3px solid var(--accent-cyan);
      border-radius: 50%;
      height: 30px;
      width: 30px;
      position: absolute;
      left: -3px;
      top: -3px;
      animation: pulse-ring-animation 1.8s ease-out infinite;
      opacity: 0;
    }
    .pulse-dot {
      background-color: var(--accent-cyan);
      border: 2px solid #fff;
      border-radius: 50%;
      height: 12px;
      width: 12px;
      position: absolute;
      left: 6px;
      top: 6px;
      box-shadow: 0 0 8px var(--accent-cyan);
    }
    @keyframes pulse-ring-animation {
      0% { transform: scale(0.3); opacity: 0; }
      50% { opacity: 0.5; }
      100% { transform: scale(1.3); opacity: 0; }
    }
  `;
  document.head.appendChild(style);

  map.on('dragstart', () => {
    mapCentered = false;
  });
}

function addPointToMap(pt) {
  if (!map) return;
  
  const latLng = [pt.lat, pt.lon];
  userMarker.setLatLng(latLng);

  if (mapCentered) {
    map.setView(latLng, 16);
  }

  if (tripCoords.length > 1) {
    const prevPt = tripCoords[tripCoords.length - 2];
    const prevLatLng = [prevPt.lat, prevPt.lon];
    
    let segmentColor = 'var(--accent-cyan)';
    
    // Highlight points carrying warning flags or events
    if (pt.userEvent === 'USER_MARKED') {
      segmentColor = 'var(--accent-orange)'; // User flagged event
    } else if (pt.diagnosticAlert !== "") {
      segmentColor = 'var(--accent-pink)'; // Auto diagnostic alert segment
    } else {
      const currentKmh = pt.speed * 3.6;
      if (pt.speedLimit !== null) {
        if (currentKmh > pt.speedLimit * 1.05) {
          segmentColor = 'var(--accent-red)';
        } else if (currentKmh > pt.speedLimit * 0.8) {
          segmentColor = 'var(--accent-orange)';
        } else {
          segmentColor = 'var(--accent-green)';
        }
      } else {
        if (currentKmh > 80) segmentColor = 'var(--accent-red)';
        else if (currentKmh > 40) segmentColor = 'var(--accent-orange)';
        else if (currentKmh > 3) segmentColor = 'var(--accent-green)';
      }
    }

    L.polyline([prevLatLng, latLng], {
      color: segmentColor,
      weight: 6,
      opacity: 0.9,
      lineCap: 'round'
    }).addTo(activePolylineGroup);
  }
}

// -------------------------------------------------------------
// Real-time Charts (Chart.js)
// -------------------------------------------------------------
function initCharts() {
  const ctx = document.getElementById('telemetryChart').getContext('2d');
  
  telemetryChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Speed',
          data: [],
          borderColor: '#00f2fe',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          backgroundColor: 'rgba(0, 242, 254, 0.05)',
          yAxisID: 'y'
        },
        {
          label: 'Elevation',
          data: [],
          borderColor: '#7f00ff',
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: { color: '#8c9cb2', font: { family: 'Outfit', weight: 600 } }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } }
        },
        y: {
          title: { display: true, text: 'Speed', color: '#00f2fe', font: { family: 'Outfit', weight: 600 } },
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } },
          position: 'left'
        },
        y1: {
          title: { display: true, text: 'Altitude', color: '#7f00ff', font: { family: 'Outfit', weight: 600 } },
          grid: { drawOnChartArea: false },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } },
          position: 'right'
        }
      }
    }
  });
}

function resetCharts() {
  if (!telemetryChart) return;
  telemetryChart.data.labels = [];
  telemetryChart.data.datasets[0].data = [];
  telemetryChart.data.datasets[1].data = [];
  telemetryChart.update();
}

function addPointToCharts(pt) {
  if (!telemetryChart) return;

  const seconds = Math.floor((pt.time - startTime) / 1000);
  const timeLabel = formatDuration(seconds);
  const displaySpeed = convertSpeed(pt.speed);
  const displayElev = convertElevation(pt.altitude);

  telemetryChart.data.labels.push(timeLabel);
  telemetryChart.data.datasets[0].data.push(displaySpeed);
  telemetryChart.data.datasets[1].data.push(displayElev);

  if (telemetryChart.data.labels.length > 50) {
    telemetryChart.data.labels.shift();
    telemetryChart.data.datasets[0].data.shift();
    telemetryChart.data.datasets[1].data.shift();
  }

  telemetryChart.update('none');
}

// -------------------------------------------------------------
// Saved Trip History & Rendering
// -------------------------------------------------------------
async function loadTripHistory() {
  const historyList = document.getElementById('history-list');
  const countBadge = document.getElementById('history-count');
  
  const trips = await getAllTripsFromDB();
  countBadge.textContent = `${trips.length} SAVED TRIPS`;
  
  if (trips.length === 0) {
    historyList.innerHTML = `
      <div class="empty-history">
        <p>No trips recorded yet. Start moving or hit Start Trip to log data!</p>
      </div>`;
    return;
  }

  historyList.innerHTML = '';
  trips.forEach(trip => {
    const formattedDistance = convertDistance(trip.distance);
    const speedUnit = settings.units === 'imperial' ? 'mph' : 'km/h';
    const distUnit = settings.units === 'imperial' ? 'mi' : 'km';
    const profileTag = trip.trackingProfile === 'high-res' ? 'DIAGNOSTIC (1s)' : (trip.trackingProfile === 'standard' ? 'LOG (10s)' : 'SMART (15m)');
    
    // Count alerts and event markings
    const alertCount = trip.coords.filter(c => c.diagnosticAlert && c.diagnosticAlert !== "").length;
    const eventCount = trip.coords.filter(c => c.userEvent && c.userEvent !== "").length;
    const diagnosticsAlertIndicator = (alertCount > 0 || eventCount > 0) 
      ? `<span style="font-size: 0.65rem; color: var(--accent-orange); font-weight: 800; margin-left: 10px;">⚠️ ${alertCount} alerts / ${eventCount} events</span>` 
      : '';

    const card = document.createElement('div');
    card.className = 'trip-card';
    card.dataset.tripId = trip.id;
    card.innerHTML = `
      <div class="trip-card-header">
        <span class="trip-date">${trip.date}</span>
        <span class="trip-duration-tag">${formatDuration(trip.duration)}</span>
      </div>
      <div style="font-size: 0.65rem; color: var(--accent-purple); font-weight: 800; margin-top: -8px; display: flex; align-items: center;">
        <span>${profileTag}</span>
        ${diagnosticsAlertIndicator}
      </div>
      <div class="trip-card-stats">
        <div class="trip-card-stat">
          <span class="trip-card-label">DISTANCE</span>
          <span class="trip-card-val">${formattedDistance.toFixed(2)} ${distUnit}</span>
        </div>
        <div class="trip-card-stat">
          <span class="trip-card-label">AVG SPEED</span>
          <span class="trip-card-val">${convertSpeed(trip.avgSpeed).toFixed(1)} ${speedUnit}</span>
        </div>
      </div>
    `;
    
    card.addEventListener('click', () => {
      openTripModal(trip);
    });
    
    historyList.appendChild(card);
  });
}

// -------------------------------------------------------------
// Trip Detail Modal & Interactive Inspection
// -------------------------------------------------------------
let modalMap = null;
let modalChart = null;
let selectedModalTrip = null;

function openTripModal(trip) {
  selectedModalTrip = trip;
  
  const modal = document.getElementById('trip-modal');
  document.getElementById('modal-trip-title').textContent = `Trip Details - ${trip.date}`;
  
  const formattedDistance = convertDistance(trip.distance);
  const displayAvgSpeed = convertSpeed(trip.avgSpeed);
  const displayMaxSpeed = convertSpeed(trip.maxSpeed);
  const displayElev = convertElevation(trip.elevationGain);

  const speedUnit = settings.units === 'imperial' ? 'mph' : 'km/h';
  const distUnit = settings.units === 'imperial' ? 'mi' : 'km';
  const elevUnit = settings.units === 'imperial' ? 'ft' : 'm';

  document.getElementById('m-distance').textContent = `${formattedDistance.toFixed(2)} ${distUnit}`;
  document.getElementById('m-duration').textContent = formatDuration(trip.duration);
  document.getElementById('m-speeds').textContent = `${displayAvgSpeed.toFixed(1)} / ${displayMaxSpeed.toFixed(1)} ${speedUnit}`;
  document.getElementById('m-elevation').textContent = `${Math.round(displayElev)} ${elevUnit} / ${trip.maxIncline.toFixed(1)}%`;
  
  modal.classList.add('show');

  setTimeout(() => {
    renderModalMap(trip);
    renderModalChart(trip);
  }, 100);
}

function closeTripModal() {
  const modal = document.getElementById('trip-modal');
  modal.classList.remove('show');
  selectedModalTrip = null;
  
  if (modalMap) {
    modalMap.remove();
    modalMap = null;
  }
  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
}

function renderModalMap(trip) {
  if (modalMap) modalMap.remove();

  modalMap = L.map('modal-map', {
    zoomControl: true,
    attributionControl: false
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(modalMap);

  const coords = trip.coords.map(c => [c.lat, c.lon]);
  
  for (let i = 1; i < trip.coords.length; i++) {
    const pt = trip.coords[i];
    const prevPt = trip.coords[i - 1];
    const latLng = [pt.lat, pt.lon];
    const prevLatLng = [prevPt.lat, prevPt.lon];

    let segmentColor = 'var(--accent-cyan)';
    
    if (pt.userEvent === 'USER_MARKED') {
      segmentColor = 'var(--accent-orange)';
    } else if (pt.diagnosticAlert && pt.diagnosticAlert !== "") {
      segmentColor = 'var(--accent-pink)';
    } else {
      const currentKmh = pt.speed * 3.6;
      if (pt.speedLimit !== null) {
        if (currentKmh > pt.speedLimit * 1.05) {
          segmentColor = 'var(--accent-red)';
        } else if (currentKmh > pt.speedLimit * 0.8) {
          segmentColor = 'var(--accent-orange)';
        } else {
          segmentColor = 'var(--accent-green)';
        }
      } else {
        if (currentKmh > 80) segmentColor = 'var(--accent-red)';
        else if (currentKmh > 40) segmentColor = 'var(--accent-orange)';
        else if (currentKmh > 3) segmentColor = 'var(--accent-green)';
      }
    }

    L.polyline([prevLatLng, latLng], {
      color: segmentColor,
      weight: 6,
      opacity: 0.9,
      lineCap: 'round'
    }).addTo(modalMap);
  }

  if (coords.length > 0) {
    const greenDot = L.divIcon({
      html: `<div style="background-color: var(--accent-green); width: 12px; height: 12px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 6px var(--accent-green);"></div>`,
      className: 'start-marker',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
    const redDot = L.divIcon({
      html: `<div style="background-color: var(--accent-red); width: 12px; height: 12px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 6px var(--accent-red);"></div>`,
      className: 'end-marker',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });

    L.marker(coords[0], { icon: greenDot }).addTo(modalMap);
    L.marker(coords[coords.length - 1], { icon: redDot }).addTo(modalMap);

    const bounds = L.latLngBounds(coords);
    modalMap.fitBounds(bounds, { padding: [20, 20] });
  }
}

function renderModalChart(trip) {
  if (modalChart) modalChart.destroy();

  const ctx = document.getElementById('modalChart').getContext('2d');
  
  const labels = [];
  const speedData = [];
  const elevData = [];

  trip.coords.forEach(pt => {
    const seconds = Math.floor((pt.time - trip.id) / 1000);
    labels.push(formatDuration(seconds));
    speedData.push(convertSpeed(pt.speed));
    elevData.push(convertElevation(pt.altitude));
  });

  modalChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Speed',
          data: speedData,
          borderColor: '#00f2fe',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          backgroundColor: 'rgba(0, 242, 254, 0.05)',
          yAxisID: 'y'
        },
        {
          label: 'Elevation',
          data: elevData,
          borderColor: '#7f00ff',
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8c9cb2', font: { family: 'Outfit', weight: 600 } } }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } }
        },
        y: {
          title: { display: true, text: 'Speed', color: '#00f2fe', font: { family: 'Outfit', weight: 600 } },
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } },
          position: 'left'
        },
        y1: {
          title: { display: true, text: 'Elevation', color: '#7f00ff', font: { family: 'Outfit', weight: 600 } },
          grid: { drawOnChartArea: false },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } },
          position: 'right'
        }
      }
    }
  });
}

// -------------------------------------------------------------
// Data Exporters (GPX / JSON / CSV)
// -------------------------------------------------------------
function exportToGPX(trip) {
  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="PWAMotionTracker" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>Trip on ${trip.date}</name>
    <time>${new Date(trip.id).toISOString()}</time>
  </metadata>
  <trk>
    <name>${trip.date}</name>
    <desc>Motion Tracker Recorded Trip. Distance: ${(trip.distance/1000).toFixed(2)} km, Duration: ${formatDuration(trip.duration)}</desc>
    <trkseg>
`;

  trip.coords.forEach(pt => {
    const timeISO = new Date(pt.time).toISOString();
    gpx += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">
        <ele>${pt.altitude.toFixed(2)}</ele>
        <time>${timeISO}</time>
        <extensions>
          <speed>${pt.speed.toFixed(3)}</speed>
          <incline>${pt.incline.toFixed(2)}</incline>
          <speedlimit>${pt.speedLimit !== null ? pt.speedLimit : ''}</speedlimit>
          <gx>${pt.gx !== undefined ? pt.gx.toFixed(3) : ''}</gx>
          <gy>${pt.gy !== undefined ? pt.gy.toFixed(3) : ''}</gy>
          <gz>${pt.gz !== undefined ? pt.gz.toFixed(3) : ''}</gz>
          <user_event>${pt.userEvent || ''}</user_event>
          <diag_alert>${pt.diagnosticAlert || ''}</diag_alert>
        </extensions>
      </trkpt>
`;
  });

  gpx += `    </trkseg>
  </trk>
</gpx>`;

  downloadFile(gpx, `trip_${trip.id}.gpx`, 'application/gpx+xml');
}

function exportToJSON(trip) {
  const jsonStr = JSON.stringify(trip, null, 2);
  downloadFile(jsonStr, `trip_${trip.id}.json`, 'application/json');
}

// Upgraded vehicle diagnostics CSV export
function exportToCSV(trip) {
  const speedUnit = settings.units === 'imperial' ? 'mph' : 'km/h';
  const elevUnit = settings.units === 'imperial' ? 'ft' : 'm';
  
  let csv = `Trip Date,${trip.date}\n`;
  csv += `Trip ID,${trip.id}\n`;
  csv += `Duration,${formatDuration(trip.duration)}\n`;
  csv += `Tracking Resolution Profile,${trip.trackingProfile || 'N/A'}\n`;
  csv += `Total Distance (${settings.units === 'imperial' ? 'mi' : 'km'}),${convertDistance(trip.distance).toFixed(3)}\n\n`;
  
  // Tabular column headers
  csv += `Timestamp,Date,Elapsed_Time_Sec,Speed_${speedUnit},Speed_Limit_${speedUnit},Road_Name,Acceleration_GPS_mps2,Incline_Pct,Altitude_${elevUnit},G_Force_Lateral_X,G_Force_Longitudinal_Y,G_Force_Vertical_Z,G_Force_Vector,User_Event_Flag,Diagnostic_Alert_Flag\n`;
  
  trip.coords.forEach((pt, idx) => {
    const elapsed = Math.round((pt.time - trip.id) / 1000);
    const dateStr = new Date(pt.time).toLocaleTimeString();
    const speedVal = convertSpeed(pt.speed).toFixed(2);
    const speedLimit = pt.speedLimit !== null ? pt.speedLimit : '';
    const road = pt.roadName ? `"${pt.roadName.replace(/"/g, '""')}"` : 'Unknown';
    const inclineVal = pt.incline.toFixed(2);
    const elevVal = convertElevation(pt.altitude).toFixed(2);
    
    // GPS acceleration derivative dv/dt
    let gpsAccel = 0;
    if (idx > 0) {
      const prev = trip.coords[idx - 1];
      const dv = pt.speed - prev.speed;
      const dt = (pt.time - prev.time) / 1000;
      if (dt > 0) {
        gpsAccel = dv / dt;
      }
    }
    
    // Accelerometer values
    const gx = pt.gx !== undefined ? pt.gx.toFixed(3) : '0.000';
    const gy = pt.gy !== undefined ? pt.gy.toFixed(3) : '0.000';
    const gz = pt.gz !== undefined ? pt.gz.toFixed(3) : '1.000';
    const gtotal = pt.gtotal !== undefined ? pt.gtotal.toFixed(3) : '1.000';
    
    const userEv = pt.userEvent || '';
    const diagAl = pt.diagnosticAlert || '';
    
    csv += `${pt.time},${dateStr},${elapsed},${speedVal},${speedLimit},${road},${gpsAccel.toFixed(3)},${inclineVal},${elevVal},${gx},${gy},${gz},${gtotal},${userEv},${diagAl}\n`;
  });
  
  downloadFile(csv, `trip_diagnostics_${trip.id}.csv`, 'text/csv');
}

function downloadFile(content, fileName, contentType) {
  const a = document.createElement("a");
  const file = new Blob([content], { type: contentType });
  a.href = URL.createObjectURL(file);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  await initIndexedDB();
  await loadTripHistory();
  
  initMap();
  initCharts();
  initAccelerometer();

  if ('geolocation' in navigator) {
    watchId = navigator.geolocation.watchPosition(
      handleGPSUpdate,
      handleGPSFail,
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  } else {
    updateGPSBadge(false, "GPS NOT SUPPORTED");
    alert("Geolocation is required for this application to function.");
  }

  // Button Listeners
  document.getElementById('track-btn').addEventListener('click', toggleTracking);
  
  document.getElementById('mark-event-btn').addEventListener('click', () => {
    if (isTracking) {
      pendingUserEvent = true;
      console.log("Flagging next waypoint with USER_MARKED.");
    }
  });

  document.getElementById('tab-map').addEventListener('click', (e) => {
    document.getElementById('tab-map').classList.add('active');
    document.getElementById('tab-charts').classList.remove('active');
    document.getElementById('map-container').classList.add('active');
    document.getElementById('charts-container').classList.remove('active');
    if (map) map.invalidateSize();
  });

  document.getElementById('tab-charts').addEventListener('click', (e) => {
    document.getElementById('tab-charts').classList.add('active');
    document.getElementById('tab-map').classList.remove('active');
    document.getElementById('charts-container').classList.add('active');
    document.getElementById('map-container').classList.remove('active');
  });

  // Settings switches
  document.getElementById('profile-toggle').addEventListener('change', (e) => {
    settings.trackingProfile = e.target.value;
    console.log(`Resolution profile switched to: ${settings.trackingProfile}`);
  });

  document.getElementById('wake-lock-toggle').addEventListener('change', (e) => {
    settings.keepAwake = e.target.checked;
    if (!settings.keepAwake) {
      releaseWakeLock();
    } else if (isTracking) {
      requestWakeLock();
    }
  });

  const autoToggle = document.getElementById('auto-start-toggle');
  const autoRow = document.getElementById('auto-speed-row');
  autoToggle.addEventListener('change', (e) => {
    settings.autoStart = e.target.checked;
    autoRow.style.display = settings.autoStart ? 'flex' : 'none';
  });

  document.getElementById('auto-speed-val').addEventListener('change', (e) => {
    settings.autoStartThreshold = parseInt(e.target.value, 10);
  });

  document.getElementById('units-toggle').addEventListener('change', async (e) => {
    settings.units = e.target.value;
    document.getElementById('speed-unit-label').textContent = settings.units === 'imperial' ? 'mph' : 'km/h';
    await loadTripHistory();
  });

  // Modal actions
  document.getElementById('modal-close').addEventListener('click', closeTripModal);
  
  document.getElementById('export-csv-btn').addEventListener('click', () => {
    if (selectedModalTrip) exportToCSV(selectedModalTrip);
  });

  document.getElementById('export-gpx-btn').addEventListener('click', () => {
    if (selectedModalTrip) exportToGPX(selectedModalTrip);
  });

  document.getElementById('export-json-btn').addEventListener('click', () => {
    if (selectedModalTrip) exportToJSON(selectedModalTrip);
  });

  document.getElementById('delete-trip-btn').addEventListener('click', async () => {
    if (selectedModalTrip) {
      if (confirm("Are you sure you want to delete this trip record?")) {
        await deleteTripFromDB(selectedModalTrip.id);
        closeTripModal();
        await loadTripHistory();
      }
    }
  });

  window.addEventListener('click', (e) => {
    const modal = document.getElementById('trip-modal');
    if (e.target === modal) {
      closeTripModal();
    }
  });

  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('pwa-install-btn');
    installBtn.style.display = 'inline-block';
    
    installBtn.addEventListener('click', () => {
      installBtn.style.display = 'none';
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('User accepted install prompt');
        }
        deferredPrompt = null;
      });
    });
  });

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      console.log('ServiceWorker registered successfully.');
    } catch (err) {
      console.warn('ServiceWorker registration failed: ', err);
    }
  }
});
