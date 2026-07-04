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

// Map variables
let map = null;
let activePolylineGroup = null;
let userMarker = null;
let mapCentered = true;

// Chart variables
let telemetryChart = null;

// Settings & Config
let settings = {
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
      // Return sorted by date/id descending
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

// Handle visibility change to re-acquire wake lock if tab is resumed
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

// Haversine formula to compute distance between points in meters
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
  
  // Also verify they moved at least 15 meters to prevent spamming queries
  const distMoved = getDistance(lastOsmCoords.lat, lastOsmCoords.lon, lat, lon);
  if (distMoved < 15 && lastOsmQueryTime !== 0) return;

  lastOsmQueryTime = now;
  lastOsmCoords = { lat, lon };

  // Overpass QL query: Find ways within 30 meters of coordinates tagged as 'highway'
  const query = `[out:json];
    way(around:30, ${lat}, ${lon})[highway];
    out tags;`;

  try {
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('OSM Server error');
    
    const data = await response.json();
    if (data && data.elements && data.elements.length > 0) {
      // Find the closest/most descriptive road way
      const ways = data.elements;
      let targetWay = ways[0];
      
      // Prefer ways with explicit maxspeed tag
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
          // If unit is mph, convert or keep based on selection
          if (settings.units === 'metric') {
            lastSpeedLimit = Math.round(parsedLimit * 1.60934); // mph -> km/h
          } else {
            lastSpeedLimit = parsedLimit;
          }
        } else {
          // Default Overpass maxspeed tags are usually in km/h unless specified
          if (settings.units === 'imperial') {
            lastSpeedLimit = Math.round(parsedLimit * 0.621371); // km/h -> mph
          } else {
            lastSpeedLimit = parsedLimit;
          }
        }
      } else if (tags.highway) {
        // Fallback speed limit based on highway type (Standard European/Global classifications)
        const highwayTypes = {
          motorway: 110,
          trunk: 90,
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
    // Silent fail to prevent tracking crash
  }
}

// -------------------------------------------------------------
// Tracking GPS Updates
// -------------------------------------------------------------
function handleGPSUpdate(position) {
  const coords = position.coords;
  const accuracy = coords.accuracy;
  const currentTimestamp = position.timestamp;

  // Filter out updates with terrible accuracy (> 50m) to protect from GPS jumps
  if (accuracy > 50) {
    updateGPSBadge(false, `LOW ACCURACY (${Math.round(accuracy)}m)`);
    return;
  }

  updateGPSBadge(true, "GPS ACTIVE");

  const currentLat = coords.latitude;
  const currentLon = coords.longitude;
  
  // Speed calculation: Use coords.speed (m/s) if valid, otherwise compute from delta
  let speedMps = (coords.speed !== null && coords.speed >= 0) ? coords.speed : 0;
  
  // Parse altitude and apply Exponential Moving Average (EMA) filtering
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
    
    // Calculate distance since last point
    stepDistance = getDistance(lastPt.lat, lastPt.lon, currentLat, currentLon);
    
    // Time delta in seconds
    const timeDelta = (currentTimestamp - lastPt.time) / 1000;
    
    // Fallback speed calculation if native coords.speed is zero or invalid
    if ((coords.speed === null || coords.speed <= 0.1) && stepDistance > 1 && timeDelta > 0) {
      speedMps = stepDistance / timeDelta;
    }

    if (isTracking) {
      // Accumulate total distance
      totalDistance += stepDistance;
      
      // Calculate altitude gain
      if (coords.altitude !== null && previousFilteredAltitude !== null) {
        const altitudeDelta = filteredAltitude - previousFilteredAltitude;
        if (altitudeDelta > 0) {
          totalElevationGain += altitudeDelta;
        }
        
        // Calculate incline slope: elevation delta / horizontal distance * 100
        // Use a minimum distance (e.g. 8m) to avoid massive noise fluctuations
        if (stepDistance > 8) {
          computedIncline = (altitudeDelta / stepDistance) * 100;
          // Clamp incline to realistic slopes
          computedIncline = Math.max(-40, Math.min(40, computedIncline));
          if (Math.abs(computedIncline) > Math.abs(maxIncline)) {
            maxIncline = computedIncline;
          }
        } else {
          computedIncline = lastPt.incline || 0; // carry over
        }
      }
    }
  }

  // Update speed records
  if (speedMps > maxSpeed && isTracking) {
    maxSpeed = speedMps;
  }

  // Check Road Speed Limits
  fetchRoadSpeedLimit(currentLat, currentLon);

  // Package current waypoint
  const currentWaypoint = {
    lat: currentLat,
    lon: currentLon,
    time: currentTimestamp,
    speed: speedMps,
    altitude: filteredAltitude,
    rawAltitude: rawAltitude,
    incline: computedIncline,
    speedLimit: lastSpeedLimit,
    roadName: speedLimitRoadName
  };

  previousFilteredAltitude = filteredAltitude;

  // Render values to UI immediately
  updateLiveUI(currentWaypoint);

  // If tracking is active, store coordinate and update map/charts
  if (isTracking) {
    tripCoords.push(currentWaypoint);
    addPointToMap(currentWaypoint);
    addPointToCharts(currentWaypoint);
  } else {
    // Auto start check when idle
    handleAutoStartCheck(speedMps);
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
    // Must exceed threshold for 3 consecutive GPS updates (~3-5 seconds)
    if (autoStartTriggerPoints >= 3) {
      console.log(`Auto-start triggered at speed: ${currentSpeedKmh.toFixed(1)} km/h`);
      toggleTracking();
    }
  } else {
    // Reset points on slow down
    autoStartTriggerPoints = 0;
  }
}

// -------------------------------------------------------------
// UI Updates
// -------------------------------------------------------------
function updateLiveUI(pt) {
  const displaySpeed = convertSpeed(pt.speed);
  document.getElementById('current-speed').textContent = Math.round(displaySpeed);

  // Speedometer circular gauge calculation
  // Base circle circumference: stroke-dasharray = 353 (112px path)
  // Arc represents 0 to 140 km/h (or 90 mph)
  const maxScale = settings.units === 'imperial' ? 90 : 140;
  const fillPct = Math.min(100, (displaySpeed / maxScale) * 100);
  // Calculate dash offset: 353 = empty, 0 = full (but arc is 75% of a full circle)
  // Active arc length is approx 353
  const offset = 353 - (353 * (fillPct / 100));
  document.getElementById('speed-progress').style.strokeDashoffset = offset;

  // Handle speed limits and warning flash
  const limitBox = document.getElementById('speed-limit-display');
  const warningOverlay = document.getElementById('speeding-warning');
  
  if (pt.speedLimit !== null) {
    limitBox.classList.remove('hide');
    document.getElementById('speed-limit-val').textContent = pt.speedLimit;
    
    // Warning trigger (5% threshold buffer above speed limit)
    if (displaySpeed > pt.speedLimit * 1.05) {
      warningOverlay.classList.remove('hide');
      document.getElementById('speed-progress').style.stroke = 'var(--accent-red)';
    } else {
      warningOverlay.classList.add('hide');
      // Dynamic color depending on acceleration or safe speeds
      document.getElementById('speed-progress').style.stroke = 'var(--accent-cyan)';
    }
  } else {
    limitBox.classList.add('hide');
    warningOverlay.classList.add('hide');
    document.getElementById('speed-progress').style.stroke = 'var(--accent-cyan)';
  }

  // Update stat widgets (if currently tracking)
  if (isTracking) {
    const formattedDistance = convertDistance(totalDistance);
    const speedUnit = settings.units === 'imperial' ? 'mph' : 'km/h';
    const distUnit = settings.units === 'imperial' ? 'mi' : 'km';
    const elevUnit = settings.units === 'imperial' ? 'ft' : 'm';

    // Duration timer is updated on secondary interval (timerInterval)
    document.getElementById('stat-distance').innerHTML = `${formattedDistance.toFixed(2)} <span class="sub-unit">${distUnit}</span>`;
    
    // Average Speed
    const avgSpeedMps = elapsedSeconds > 0 ? (totalDistance / elapsedSeconds) : 0;
    document.getElementById('stat-avg-speed').innerHTML = `${convertSpeed(avgSpeedMps).toFixed(1)} <span class="sub-unit">${speedUnit}</span>`;
    
    // Max Speed
    document.getElementById('stat-max-speed').innerHTML = `${convertSpeed(maxSpeed).toFixed(1)} <span class="sub-unit">${speedUnit}</span>`;
    
    // Incline
    document.getElementById('stat-incline').innerHTML = `${pt.incline.toFixed(1)} <span class="sub-unit">%</span>`;
    
    // Elevation Gain
    document.getElementById('stat-elevation').innerHTML = `${Math.round(convertElevation(totalElevationGain))} <span class="sub-unit">${elevUnit}</span>`;
  }
}

// -------------------------------------------------------------
// Tracking Actions
// -------------------------------------------------------------
async function toggleTracking() {
  const btn = document.getElementById('track-btn');
  
  if (!isTracking) {
    // Start tracking
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
    
    btn.className = 'btn btn-primary btn-stop';
    btn.innerHTML = `<span class="btn-icon">■</span><span class="btn-text">STOP TRIP</span>`;

    // Initialize map track layers
    if (activePolylineGroup) {
      activePolylineGroup.clearLayers();
    }
    
    // Reset Telemetry Charts
    resetCharts();

    // Trigger timer interval
    timerInterval = setInterval(() => {
      elapsedSeconds++;
      document.getElementById('stat-duration').textContent = formatDuration(elapsedSeconds);
    }, 1000);

    // Request Wake Lock
    await requestWakeLock();
    
    console.log("Trip tracking started...");
  } else {
    // Stop tracking
    isTracking = false;
    clearInterval(timerInterval);
    releaseWakeLock();
    
    btn.className = 'btn btn-primary btn-start';
    btn.innerHTML = `<span class="btn-icon">▶</span><span class="btn-text">START TRIP</span>`;

    console.log("Trip tracking stopped.");
    
    // If we have actual tracking data, save to DB
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
        coords: tripCoords
      };
      
      await saveTripToDB(newTrip);
      await loadTripHistory();
      
      // Open modal summary for the user to review
      openTripModal(newTrip);
    } else {
      alert("Trip was too short to record.");
    }

    // Reset fields
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
  // Leaflet initialization
  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([0, 0], 2);

  // High premium dark-mode tiles (CartoDB Dark Matter)
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  activePolylineGroup = L.featureGroup().addTo(map);

  // Custom User Marker containing directional arrow
  const pulseIcon = L.divIcon({
    className: 'custom-pulse-marker',
    html: `<div class="pulse-ring"></div><div class="pulse-dot"></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });
  
  userMarker = L.marker([0, 0], { icon: pulseIcon }).addTo(map);
  
  // Custom CSS for pulse marker (appended to head)
  const style = document.createElement('style');
  style.innerHTML = `
    .custom-pulse-marker {
      position: relative;
    }
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

  // Map behavior
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

  // Draw segment on active map. We color code based on speed variations:
  // Speed variations logic: compare speed limit if available, or just absolute speeds
  // Green: Speed < 30km/h (slow/city/climb) or below speed limit
  // Yellow/Orange: Speed between 30 and 70km/h or accelerating
  // Red: Speed > 70km/h or exceeding speed limit
  if (tripCoords.length > 1) {
    const prevPt = tripCoords[tripCoords.length - 2];
    const prevLatLng = [prevPt.lat, prevPt.lon];
    
    let segmentColor = 'var(--accent-cyan)'; // cyan as normal/idle
    const currentKmh = pt.speed * 3.6;
    
    if (pt.speedLimit !== null) {
      if (currentKmh > pt.speedLimit * 1.05) {
        segmentColor = 'var(--accent-red)'; // Speeding
      } else if (currentKmh > pt.speedLimit * 0.8) {
        segmentColor = 'var(--accent-orange)'; // Fast/close to limit
      } else {
        segmentColor = 'var(--accent-green)'; // Safe speed
      }
    } else {
      // General fallbacks if no road speed limit is retrieved
      if (currentKmh > 80) {
        segmentColor = 'var(--accent-red)';
      } else if (currentKmh > 40) {
        segmentColor = 'var(--accent-orange)';
      } else if (currentKmh > 3) {
        segmentColor = 'var(--accent-green)';
      }
    }

    const poly = L.polyline([prevLatLng, latLng], {
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
  
  // Custom dark styles config for chart
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
          title: {
            display: true,
            text: 'Speed',
            color: '#00f2fe',
            font: { family: 'Outfit', weight: 600 }
          },
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#8c9cb2', font: { family: 'Outfit' } },
          position: 'left'
        },
        y1: {
          title: {
            display: true,
            text: 'Altitude',
            color: '#7f00ff',
            font: { family: 'Outfit', weight: 600 }
          },
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

  // Keep dynamic window size of 50 points on graph to maintain responsiveness
  if (telemetryChart.data.labels.length > 50) {
    telemetryChart.data.labels.shift();
    telemetryChart.data.datasets[0].data.shift();
    telemetryChart.data.datasets[1].data.shift();
  }

  telemetryChart.update('none'); // silent update
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

    const card = document.createElement('div');
    card.className = 'trip-card';
    card.dataset.tripId = trip.id;
    card.innerHTML = `
      <div class="trip-card-header">
        <span class="trip-date">${trip.date}</span>
        <span class="trip-duration-tag">${formatDuration(trip.duration)}</span>
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
  
  // Format metric vs imperial values
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

  // Load Map & Charts inside modal asynchronously after rendering
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
  
  // Render speed segments
  for (let i = 1; i < trip.coords.length; i++) {
    const pt = trip.coords[i];
    const prevPt = trip.coords[i - 1];
    const latLng = [pt.lat, pt.lon];
    const prevLatLng = [prevPt.lat, prevPt.lon];

    let segmentColor = 'var(--accent-cyan)';
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

    L.polyline([prevLatLng, latLng], {
      color: segmentColor,
      weight: 6,
      opacity: 0.9,
      lineCap: 'round'
    }).addTo(modalMap);
  }

  // Draw markers at start and end
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
// Data Exporters (GPX / JSON)
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
  // 1. Setup DB
  await initIndexedDB();
  
  // 2. Load History
  await loadTripHistory();
  
  // 3. Setup Maps & Charts
  initMap();
  initCharts();

  // 4. Geolocation Engine launch
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

  // 5. Button Listeners
  document.getElementById('track-btn').addEventListener('click', toggleTracking);
  
  // UI Tabs switching
  document.getElementById('tab-map').addEventListener('click', (e) => {
    document.getElementById('tab-map').classList.add('active');
    document.getElementById('tab-charts').classList.remove('active');
    document.getElementById('map-container').classList.add('active');
    document.getElementById('charts-container').classList.remove('active');
    // Leaflet map refresh size on toggle
    if (map) map.invalidateSize();
  });

  document.getElementById('tab-charts').addEventListener('click', (e) => {
    document.getElementById('tab-charts').classList.add('active');
    document.getElementById('tab-map').classList.remove('active');
    document.getElementById('charts-container').classList.add('active');
    document.getElementById('map-container').classList.remove('active');
  });

  // Settings switches
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
    
    // Update speedometer unit label text
    document.getElementById('speed-unit-label').textContent = settings.units === 'imperial' ? 'mph' : 'km/h';
    
    // Reload history to refresh card displays
    await loadTripHistory();
  });

  // Modal actions
  document.getElementById('modal-close').addEventListener('click', closeTripModal);
  
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

  // Close modal when clicking background
  window.addEventListener('click', (e) => {
    const modal = document.getElementById('trip-modal');
    if (e.target === modal) {
      closeTripModal();
    }
  });

  // PWA Install Prompt Handler
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

  // Register PWA service worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js');
      console.log('ServiceWorker registered successfully.');
    } catch (err) {
      console.warn('ServiceWorker registration failed: ', err);
    }
  }
});
