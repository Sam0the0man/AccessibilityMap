const campusPlaces = [
    { name: "Campus place 1", coordinates: [40.8600865, -73.8846497] },
    { name: "Campus place 2", coordinates: [40.8604449, -73.8838402] },
    { name: "Campus place 3", coordinates: [40.8621068, -73.8837313] },
    { name: "Campus place 4", coordinates: [40.8620232, -73.8855916] },
    { name: "Campus place 5", coordinates: [40.861475, -73.8860378] },
    { name: "Campus place 6", coordinates: [40.861281, -73.8894435] },
    { name: "Campus place 7", coordinates: [40.8607936, -73.8865604] },
    { name: "Seismic Observatory", coordinates: [40.8603169, -73.885185], destination: true },
    { name: "Campus place 9", coordinates: [40.8596572, -73.8851094] }
];

const accessibilityMapUrl = "https://www.google.com/maps/d/u/0/edit?mid=1RyGwhJG5wtF7fe4wTgcC9pKru6GbPjs&usp=sharing";
const accessibilityMapKmlUrl = "https://www.google.com/maps/d/kml?mid=1RyGwhJG5wtF7fe4wTgcC9pKru6GbPjs&forcekml=1";
const kmlNamespace = "http://www.opengis.net/kml/2.2";
const routeJoinDistanceMeters = 10;
const maxRouteSnapDistanceMeters = 100;
const earthRadiusMeters = 6371008.8;

const map = L.map("map", { scrollWheelZoom: true });

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const campusLayer = L.featureGroup();
campusPlaces.forEach((place, index) => {
    const icon = L.divIcon({
        className: "",
        html: `<span class="map-pin${place.destination ? " map-pin--destination" : ""}"><span>${place.destination ? "★" : index + 1}</span></span>`,
        iconSize: place.destination ? [38, 38] : [32, 32],
        iconAnchor: place.destination ? [19, 34] : [16, 29],
        popupAnchor: [0, -30]
    });
    const marker = L.marker(place.coordinates, { icon, title: place.name, alt: place.name }).addTo(campusLayer);
    marker.bindPopup(place.name);
});
campusLayer.addTo(map);

const campusBounds = campusLayer.getBounds();
let activeLayer = campusLayer;
let accessibilityDataPromise;
let accessibilityData;
let selectedBuilding;
let locationWatchId = null;
let currentLocation;
let currentLocationMarker;
let locationAccuracyCircle;
let routeLayer;
let lastRoutedLocation;

const accessibilityToggle = document.getElementById("accessibility-toggle");
const directionsLink = document.getElementById("directions-link");
const directionsLinkLabel = document.getElementById("directions-link-label");
const mapModeError = document.getElementById("map-mode-error");
const mapStatusText = document.getElementById("map-status-text");
const buildingList = document.getElementById("building-list");
const routeButton = document.getElementById("route-button");
const stopLocationButton = document.getElementById("stop-location");
const routeStatus = document.getElementById("route-status");

function distanceMeters(first, second) {
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const latitudeDelta = toRadians(second[1] - first[1]);
    const longitudeDelta = toRadians(second[0] - first[0]);
    const firstLatitude = toRadians(first[1]);
    const secondLatitude = toRadians(second[1]);
    const haversine = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(firstLatitude) * Math.cos(secondLatitude) *
        Math.sin(longitudeDelta / 2) ** 2;
    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function parseCoordinates(element) {
    const coordinateElement = element.getElementsByTagNameNS(kmlNamespace, "coordinates")[0];
    if (!coordinateElement) {
        return [];
    }

    return coordinateElement.textContent.trim().split(/\s+/).filter(Boolean).map((tuple) => {
        const [longitudeText, latitudeText] = tuple.split(",");
        const longitude = Number(longitudeText);
        const latitude = Number(latitudeText);
        if (
            longitudeText === undefined ||
            latitudeText === undefined ||
            longitudeText.trim() === "" ||
            latitudeText.trim() === "" ||
            !Number.isFinite(longitude) ||
            !Number.isFinite(latitude) ||
            Math.abs(longitude) > 180 ||
            Math.abs(latitude) > 90
        ) {
            throw new Error("The accessibility map contains invalid coordinates.");
        }
        return [longitude, latitude];
    });
}

function parseGeometry(element) {
    switch (element.localName) {
        case "Point": {
            const coordinates = parseCoordinates(element);
            return coordinates.length ? { type: "Point", coordinates: coordinates[0] } : null;
        }
        case "LineString": {
            const coordinates = parseCoordinates(element);
            return coordinates.length > 1 ? { type: "LineString", coordinates } : null;
        }
        case "Polygon": {
            const boundaries = Array.from(element.children).filter((child) =>
                child.localName === "outerBoundaryIs" || child.localName === "innerBoundaryIs"
            );
            const rings = boundaries.map(parseCoordinates).filter((coordinates) => coordinates.length >= 4);
            return rings.length ? { type: "Polygon", coordinates: rings } : null;
        }
        case "MultiGeometry": {
            const geometries = Array.from(element.children).map(parseGeometry).filter(Boolean);
            return geometries.length ? { type: "GeometryCollection", geometries } : null;
        }
        default:
            return null;
    }
}

function parseAccessibilityMap(kmlText) {
    const document = new DOMParser().parseFromString(kmlText, "application/xml");
    if (document.getElementsByTagName("parsererror").length) {
        throw new Error("The accessibility map data could not be parsed.");
    }

    const features = Array.from(document.getElementsByTagNameNS(kmlNamespace, "Placemark")).flatMap((placemark) => {
        const geometryElement = Array.from(placemark.children).find((child) =>
            ["Point", "LineString", "Polygon", "MultiGeometry"].includes(child.localName)
        );
        const geometry = geometryElement && parseGeometry(geometryElement);
        if (!geometry) {
            return [];
        }

        const name = placemark.getElementsByTagNameNS(kmlNamespace, "name")[0]?.textContent.trim() || "Campus location";
        return [{ type: "Feature", properties: { name }, geometry }];
    });

    if (!features.length) {
        throw new Error("The accessibility map does not contain any supported places or paths.");
    }

    return { type: "FeatureCollection", features };
}

function addGraphEdge(graph, firstId, secondId, weight) {
    if (firstId === secondId || !Number.isFinite(weight)) {
        return;
    }

    const firstEdges = graph.adjacency.get(firstId);
    const secondEdges = graph.adjacency.get(secondId);
    if (!firstEdges.has(secondId) || firstEdges.get(secondId) > weight) {
        firstEdges.set(secondId, weight);
        secondEdges.set(firstId, weight);
    }
}

function buildRouteGraph(featureCollection) {
    const graph = {
        nodesById: new Map(),
        adjacency: new Map(),
        segments: []
    };
    const nodesByCoordinates = new Map();
    const lineEndpoints = [];
    let pathId = 0;
    let nextNodeId = 0;

    function getNode(coordinates, currentPathId) {
        const key = `${coordinates[0].toFixed(6)},${coordinates[1].toFixed(6)}`;
        let node = nodesByCoordinates.get(key);
        if (!node) {
            node = { id: nextNodeId++, coordinates, pathIds: new Set() };
            nodesByCoordinates.set(key, node);
            graph.nodesById.set(node.id, node);
            graph.adjacency.set(node.id, new Map());
        }
        node.pathIds.add(currentPathId);
        return node;
    }

    function addLine(coordinates) {
        if (coordinates.length < 2) {
            return;
        }

        const currentPathId = pathId++;
        const nodes = coordinates.map((coordinates) => getNode(coordinates, currentPathId));
        for (let index = 1; index < nodes.length; index += 1) {
            const first = nodes[index - 1];
            const second = nodes[index];
            const length = distanceMeters(first.coordinates, second.coordinates);
            if (first.id === second.id || length === 0) {
                continue;
            }
            graph.segments.push({
                id: graph.segments.length,
                firstId: first.id,
                secondId: second.id,
                first: first.coordinates,
                second: second.coordinates,
                length,
                pathId: currentPathId
            });
            addGraphEdge(graph, first.id, second.id, length);
        }
        lineEndpoints.push({ node: nodes[0], pathId: currentPathId });
        lineEndpoints.push({ node: nodes[nodes.length - 1], pathId: currentPathId });
    }

    function addGeometryLines(geometry) {
        if (geometry.type === "LineString") {
            addLine(geometry.coordinates);
        } else if (geometry.type === "GeometryCollection") {
            geometry.geometries.forEach(addGeometryLines);
        }
    }

    featureCollection.features.forEach((feature) => addGeometryLines(feature.geometry));
    if (!graph.segments.length) {
        throw new Error("The accessibility map does not contain any route paths.");
    }

    const nodes = Array.from(graph.nodesById.values());
    lineEndpoints.forEach(({ node, pathId: endpointPathId }) => {
        nodes.forEach((candidate) => {
            if (
                candidate.id === node.id ||
                !Array.from(candidate.pathIds).some((candidatePathId) => candidatePathId !== endpointPathId)
            ) {
                return;
            }
            const gap = distanceMeters(node.coordinates, candidate.coordinates);
            if (gap <= routeJoinDistanceMeters) {
                addGraphEdge(graph, node.id, candidate.id, gap);
            }
        });
    });

    return graph;
}

function projectToSegment(point, segment) {
    const longitudeScale = 111320 * Math.cos(point[1] * Math.PI / 180);
    const latitudeScale = 111320;
    const deltaX = (segment.second[0] - segment.first[0]) * longitudeScale;
    const deltaY = (segment.second[1] - segment.first[1]) * latitudeScale;
    const pointX = (point[0] - segment.first[0]) * longitudeScale;
    const pointY = (point[1] - segment.first[1]) * latitudeScale;
    const squaredLength = deltaX * deltaX + deltaY * deltaY;
    const progress = squaredLength === 0
        ? 0
        : Math.max(0, Math.min(1, (pointX * deltaX + pointY * deltaY) / squaredLength));
    const coordinates = [
        segment.first[0] + (segment.second[0] - segment.first[0]) * progress,
        segment.first[1] + (segment.second[1] - segment.first[1]) * progress
    ];
    return {
        segment,
        progress,
        coordinates,
        distance: distanceMeters(point, coordinates)
    };
}

function nearestRouteProjection(coordinates, graph) {
    let nearest;
    graph.segments.forEach((segment) => {
        const projection = projectToSegment(coordinates, segment);
        if (!nearest || projection.distance < nearest.distance) {
            nearest = projection;
        }
    });
    return nearest;
}

function shortestPath(graph, startId, destinationId) {
    const distances = new Map([[startId, 0]]);
    const previous = new Map();
    const remaining = new Set(graph.nodesById.keys());

    while (remaining.size) {
        let currentId;
        let currentDistance = Infinity;
        remaining.forEach((nodeId) => {
            const candidateDistance = distances.get(nodeId);
            if (candidateDistance !== undefined && candidateDistance < currentDistance) {
                currentId = nodeId;
                currentDistance = candidateDistance;
            }
        });

        if (currentId === undefined) {
            break;
        }
        remaining.delete(currentId);
        if (currentId === destinationId) {
            break;
        }

        graph.adjacency.get(currentId).forEach((edgeDistance, neighborId) => {
            if (!remaining.has(neighborId)) {
                return;
            }
            const nextDistance = currentDistance + edgeDistance;
            if (nextDistance < (distances.get(neighborId) ?? Infinity)) {
                distances.set(neighborId, nextDistance);
                previous.set(neighborId, currentId);
            }
        });
    }

    if (!distances.has(destinationId)) {
        return null;
    }

    const nodeIds = [destinationId];
    while (nodeIds[0] !== startId) {
        const predecessor = previous.get(nodeIds[0]);
        if (predecessor === undefined) {
            return null;
        }
        nodeIds.unshift(predecessor);
    }
    return { distance: distances.get(destinationId), nodeIds };
}

function findRoute(graph, startProjection, destinationProjection) {
    const startSegment = startProjection.segment;
    const destinationSegment = destinationProjection.segment;
    if (startSegment.id === destinationSegment.id) {
        const distance = Math.abs(startProjection.progress - destinationProjection.progress) * startSegment.length;
        return {
            distance,
            coordinates: [startProjection.coordinates, destinationProjection.coordinates]
        };
    }

    const startOptions = [
        { nodeId: startSegment.firstId, distance: startProjection.progress * startSegment.length },
        { nodeId: startSegment.secondId, distance: (1 - startProjection.progress) * startSegment.length }
    ];
    const destinationOptions = [
        { nodeId: destinationSegment.firstId, distance: destinationProjection.progress * destinationSegment.length },
        { nodeId: destinationSegment.secondId, distance: (1 - destinationProjection.progress) * destinationSegment.length }
    ];

    let bestRoute;
    startOptions.forEach((start) => {
        destinationOptions.forEach((destination) => {
            const path = shortestPath(graph, start.nodeId, destination.nodeId);
            if (!path) {
                return;
            }
            const distance = start.distance + path.distance + destination.distance;
            if (bestRoute && distance >= bestRoute.distance) {
                return;
            }
            bestRoute = {
                distance,
                coordinates: [
                    startProjection.coordinates,
                    ...path.nodeIds.map((id) => graph.nodesById.get(id).coordinates),
                    destinationProjection.coordinates
                ]
            };
        });
    });
    return bestRoute || null;
}

function canonicalBuildingName(name) {
    const trimmed = name.trim();
    if (/^point\s*\d+$/i.test(trimmed)) {
        return null;
    }
    if (/^(jmh|john mulcahy hall)/i.test(trimmed)) {
        return "John Mulcahy Hall";
    }
    if (/^(keating|keating hall)/i.test(trimmed)) {
        return "Keating Hall";
    }
    if (/^(library|441 e fordham rd)/i.test(trimmed)) {
        return "Duane Library";
    }
    if (/^mcshane\b/i.test(trimmed)) {
        return "McShane";
    }
    if (/^hughes\b/i.test(trimmed)) {
        return "Hughes Hall";
    }
    if (/^dealy\b/i.test(trimmed)) {
        return "Dealy Hall";
    }
    if (/^thebaud hall/i.test(trimmed)) {
        return "Thebaud Hall";
    }
    return trimmed.split(",")[0].trim();
}

function getAvailableBuildings(featureCollection, graph) {
    const buildingsByName = new Map();
    featureCollection.features.forEach((feature) => {
        if (feature.geometry.type !== "Point") {
            return;
        }

        const name = canonicalBuildingName(feature.properties.name);
        if (!name) {
            return;
        }
        const coordinates = feature.geometry.coordinates;
        const routeProjection = nearestRouteProjection(coordinates, graph);
        if (!routeProjection || routeProjection.distance > maxRouteSnapDistanceMeters) {
            return;
        }

        const key = name.toLocaleLowerCase();
        const existing = buildingsByName.get(key);
        if (!existing || routeProjection.distance < existing.routeDistance) {
            buildingsByName.set(key, { name, coordinates, routeDistance: routeProjection.distance });
        }
    });

    return Array.from(buildingsByName.values()).sort((first, second) => first.name.localeCompare(second.name));
}

function createAccessibilityData(featureCollection) {
    const routeGraph = buildRouteGraph(featureCollection);
    const buildings = getAvailableBuildings(featureCollection, routeGraph);
    if (!buildings.length) {
        throw new Error("The accessibility map does not contain any buildings connected to mapped paths.");
    }

    const layer = L.geoJSON(featureCollection, {
        pointToLayer: (_feature, coordinates) => L.circleMarker(coordinates, {
            radius: 8,
            color: "#ffffff",
            weight: 2,
            fillColor: "#860038",
            fillOpacity: 1
        }),
        style: () => ({
            color: "#860038",
            weight: 5,
            opacity: 0.9,
            lineCap: "round",
            lineJoin: "round"
        }),
        onEachFeature: (feature, featureLayer) => {
            const popup = document.createElement("span");
            popup.textContent = feature.properties.name;
            featureLayer.bindPopup(popup);
        }
    });
    if (!layer.getBounds().isValid()) {
        throw new Error("The accessibility map contains no valid locations.");
    }

    return { layer, routeGraph, buildings };
}

async function loadAccessibilityData() {
    if (!accessibilityDataPromise) {
        accessibilityDataPromise = fetch(accessibilityMapKmlUrl)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Accessibility map request failed with status ${response.status}.`);
                }
                return response.text();
            })
            .then(parseAccessibilityMap)
            .then(createAccessibilityData);
    }

    try {
        accessibilityData = await accessibilityDataPromise;
        return accessibilityData;
    } catch (error) {
        accessibilityDataPromise = undefined;
        throw error;
    }
}

function renderBuildings(buildings) {
    buildingList.replaceChildren();
    buildingList.setAttribute("aria-busy", "false");
    buildings.forEach((building) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.className = "building-option";
        button.type = "button";
        button.textContent = building.name;
        button.setAttribute("aria-pressed", String(selectedBuilding?.name === building.name));
        button.addEventListener("click", () => {
            selectedBuilding = building;
            buildingList.querySelectorAll(".building-option").forEach((option) => {
                option.setAttribute("aria-pressed", String(option === button));
            });
            routeButton.disabled = false;
            clearRoute();
            lastRoutedLocation = undefined;
            routeStatus.textContent = `${building.name} selected. Start location sharing to see the route.`;
            if (currentLocation) {
                updateDisplayedRoute();
            }
        });
        item.append(button);
        buildingList.append(item);
    });

    if (!buildings.length) {
        const message = document.createElement("li");
        message.className = "building-list-message";
        message.textContent = "No buildings with mapped paths are available.";
        buildingList.append(message);
    }
    routeButton.disabled = !selectedBuilding;
}

function fitActiveLayer() {
    if (routeLayer) {
        const bounds = routeLayer.getBounds();
        if (currentLocation) {
            bounds.extend([currentLocation.coordinates[1], currentLocation.coordinates[0]]);
        }
        map.fitBounds(bounds, { padding: [70, 70], maxZoom: 18 });
        return;
    }
    const bounds = activeLayer === campusLayer ? campusBounds : activeLayer.getBounds();
    map.fitBounds(bounds, { padding: [70, 70], maxZoom: 17 });
}

function clearRoute() {
    if (routeLayer && map.hasLayer(routeLayer)) {
        map.removeLayer(routeLayer);
    }
    routeLayer = undefined;
}

function stopLocationTracking(announce = true) {
    if (locationWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchId);
    }
    locationWatchId = null;
    currentLocation = undefined;
    lastRoutedLocation = undefined;
    if (currentLocationMarker && map.hasLayer(currentLocationMarker)) {
        map.removeLayer(currentLocationMarker);
    }
    if (locationAccuracyCircle && map.hasLayer(locationAccuracyCircle)) {
        map.removeLayer(locationAccuracyCircle);
    }
    currentLocationMarker = undefined;
    locationAccuracyCircle = undefined;
    clearRoute();
    stopLocationButton.hidden = true;
    routeButton.disabled = !selectedBuilding;
    if (announce) {
        routeStatus.textContent = "Live location stopped.";
    }
}

async function updateMapMode() {
    const useAccessibilityMap = accessibilityToggle.checked;
    mapModeError.hidden = true;
    directionsLink.href = useAccessibilityMap
        ? accessibilityMapUrl
        : "https://maps.app.goo.gl/MP8RRAFPBkcHC7h2A";
    directionsLinkLabel.textContent = useAccessibilityMap
        ? "Open accessibility map"
        : "Open walking directions";

    if (!useAccessibilityMap) {
        stopLocationTracking(false);
        if (map.hasLayer(activeLayer)) {
            map.removeLayer(activeLayer);
        }
        campusLayer.addTo(map);
        activeLayer = campusLayer;
        mapStatusText.textContent = "Rose Hill, Bronx · Campus map";
        routeStatus.textContent = "Accessibility routes are hidden. Turn on the accessibility map to route.";
        fitActiveLayer();
        return true;
    }

    mapStatusText.textContent = "Loading accessibility map…";
    try {
        const data = await loadAccessibilityData();
        renderBuildings(data.buildings);
        if (!accessibilityToggle.checked) {
            return false;
        }
        if (map.hasLayer(activeLayer)) {
            map.removeLayer(activeLayer);
        }
        data.layer.addTo(map);
        activeLayer = data.layer;
        mapStatusText.textContent = "Rose Hill, Bronx · Accessibility map";
        fitActiveLayer();
        return true;
    } catch (error) {
        if (!accessibilityToggle.checked) {
            return false;
        }
        console.error("Could not load the accessibility map.", error);
        mapStatusText.textContent = "Accessibility map unavailable";
        mapModeError.textContent = "The accessibility map could not be loaded. Try opening it directly in Google Maps.";
        mapModeError.hidden = false;
        buildingList.replaceChildren();
        buildingList.setAttribute("aria-busy", "false");
        const message = document.createElement("li");
        message.className = "building-list-message";
        message.textContent = "Buildings could not be loaded. Check your connection and try again.";
        buildingList.append(message);
        routeStatus.textContent = "Available buildings require the accessibility map.";
        routeButton.disabled = true;
        return false;
    }
}

function updateDisplayedRoute() {
    if (!accessibilityData || !selectedBuilding || !currentLocation) {
        return;
    }

    lastRoutedLocation = currentLocation.coordinates;
    const graph = accessibilityData.routeGraph;
    const startProjection = nearestRouteProjection(currentLocation.coordinates, graph);
    const destinationProjection = nearestRouteProjection(selectedBuilding.coordinates, graph);
    if (!startProjection || startProjection.distance > maxRouteSnapDistanceMeters) {
        clearRoute();
        routeStatus.textContent = "You are too far from a mapped path. Move closer to campus paths and try again.";
        return;
    }
    if (!destinationProjection || destinationProjection.distance > maxRouteSnapDistanceMeters) {
        clearRoute();
        routeStatus.textContent = `No mapped path reaches ${selectedBuilding.name}.`;
        return;
    }

    const route = findRoute(graph, startProjection, destinationProjection);
    if (!route) {
        clearRoute();
        routeStatus.textContent = `No connected mapped route reaches ${selectedBuilding.name} from here.`;
        return;
    }

    const shouldFitRoute = !routeLayer;
    clearRoute();
    const routePoints = route.coordinates.map(([longitude, latitude]) => [latitude, longitude]);
    const layers = [
        L.polyline(routePoints, {
            color: "#0877a5",
            weight: 7,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round"
        })
    ];
    if (startProjection.distance > 2) {
        layers.push(L.polyline([
            [currentLocation.coordinates[1], currentLocation.coordinates[0]],
            [startProjection.coordinates[1], startProjection.coordinates[0]]
        ], { color: "#0877a5", weight: 3, opacity: 0.85, dashArray: "5 7" }));
    }
    if (destinationProjection.distance > 2) {
        layers.push(L.polyline([
            [destinationProjection.coordinates[1], destinationProjection.coordinates[0]],
            [selectedBuilding.coordinates[1], selectedBuilding.coordinates[0]]
        ], { color: "#0877a5", weight: 3, opacity: 0.85, dashArray: "5 7" }));
    }
    layers.push(L.circleMarker([
        selectedBuilding.coordinates[1],
        selectedBuilding.coordinates[0]
    ], {
        radius: 10,
        color: "#ffffff",
        weight: 3,
        fillColor: "#c96a3d",
        fillOpacity: 1
    }).bindPopup(selectedBuilding.name));
    routeLayer = L.featureGroup(layers).addTo(map);
    currentLocationMarker.bringToFront();

    const approximateMeters = Math.round(route.distance + startProjection.distance + destinationProjection.distance);
    const accuracy = Math.round(currentLocation.accuracy);
    routeStatus.textContent = `About ${approximateMeters} m to ${selectedBuilding.name} along mapped paths. Location accuracy ±${accuracy} m.`;
    if (shouldFitRoute) {
        const bounds = routeLayer.getBounds().extend([
            currentLocation.coordinates[1],
            currentLocation.coordinates[0]
        ]);
        map.fitBounds(bounds, { padding: [70, 70], maxZoom: 18 });
    }
}

function updateLiveLocation(position) {
    const coordinates = [position.coords.longitude, position.coords.latitude];
    const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : 0;
    currentLocation = { coordinates, accuracy };
    const latLng = [coordinates[1], coordinates[0]];

    if (!locationAccuracyCircle) {
        locationAccuracyCircle = L.circle(latLng, {
            radius: accuracy,
            color: "#0877a5",
            weight: 1,
            fillColor: "#0877a5",
            fillOpacity: 0.12
        }).addTo(map);
        currentLocationMarker = L.circleMarker(latLng, {
            radius: 8,
            color: "#ffffff",
            weight: 3,
            fillColor: "#0877a5",
            fillOpacity: 1
        }).addTo(map);
        currentLocationMarker.bindPopup("Your live location");
    } else {
        locationAccuracyCircle.setLatLng(latLng).setRadius(accuracy);
        currentLocationMarker.setLatLng(latLng);
    }

    if (
        selectedBuilding &&
        (!lastRoutedLocation || distanceMeters(lastRoutedLocation, coordinates) >= 10)
    ) {
        updateDisplayedRoute();
    } else if (!selectedBuilding) {
        routeStatus.textContent = "Live location found. Select a building to see the route.";
    }
}

function handleLocationError(error) {
    const messages = {
        1: "Location permission was denied. Allow location access in your browser to get a route.",
        2: "Your location is unavailable right now. Check your device location settings.",
        3: "Getting your location timed out. Try again."
    };
    const message = messages[error.code] || "Your location could not be determined.";
    if (error.code === 1) {
        stopLocationTracking(false);
    }
    routeStatus.textContent = message;
}

async function startRouteFromLocation() {
    if (!selectedBuilding) {
        routeStatus.textContent = "Choose a destination building first.";
        return;
    }
    if (!accessibilityToggle.checked) {
        accessibilityToggle.checked = true;
        if (!await updateMapMode()) {
            return;
        }
    }
    if (!window.isSecureContext) {
        routeStatus.textContent = "Live location requires a secure connection (HTTPS) or localhost.";
        return;
    }
    if (!navigator.geolocation) {
        routeStatus.textContent = "This browser does not support live location.";
        return;
    }
    if (locationWatchId !== null) {
        return;
    }

    clearRoute();
    routeButton.disabled = true;
    stopLocationButton.hidden = false;
    routeStatus.textContent = "Requesting your location. Allow access in your browser to continue.";
    try {
        locationWatchId = navigator.geolocation.watchPosition(updateLiveLocation, handleLocationError, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 15000
        });
    } catch (error) {
        console.error("Could not start live location.", error);
        routeButton.disabled = false;
        stopLocationButton.hidden = true;
        routeStatus.textContent = "Live location could not be started. Check browser permissions and try again.";
    }
}

function initialize() {
    if (accessibilityToggle.checked) {
        updateMapMode();
    } else {
        loadAccessibilityData()
            .then((data) => renderBuildings(data.buildings))
            .catch((error) => {
                console.error("Could not load available buildings.", error);
                routeStatus.textContent = "Available buildings could not be loaded.";
            });
    }
}

accessibilityToggle.addEventListener("change", updateMapMode);
routeButton.addEventListener("click", startRouteFromLocation);
stopLocationButton.addEventListener("click", () => stopLocationTracking());
document.getElementById("reset-view").addEventListener("click", fitActiveLayer);

map.fitBounds(campusBounds, { padding: [70, 70], maxZoom: 17 });
initialize();
