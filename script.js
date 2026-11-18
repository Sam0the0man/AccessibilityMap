const accessibilityKmlUrl =
    "https://www.google.com/maps/d/kml?mid=1RyGwhJG5wtF7fe4wTgcC9pKru6GbPjs&forcekml=1";
const googleMapsDirectionsUrl = "https://www.google.com/maps/dir/";
const routeJoinDistanceMeters = 10;
const buildingSnapDistanceMeters = 100;

const map = L.map("map").setView([40.861, -73.885], 16);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 20
}).addTo(map);

const accessibilityToggle = document.getElementById("accessibility-toggle");
const mapStatus = document.getElementById("map-status-text");
const mapModeError = document.getElementById("map-mode-error");
const routeFields = document.getElementById("route-fields");
const fromBuildingSelect = document.getElementById("from-building");
const toBuildingSelect = document.getElementById("to-building");
const routeButton = document.getElementById("route-button");
const googleRouteLink = document.getElementById("google-route-link");
const routeStatus = document.getElementById("route-status");
const resetViewButton = document.getElementById("reset-view");

const selectionLayer = L.featureGroup().addTo(map);
let activeLayer;
let accessibilityData;
let accessibilityDataPromise;
let routeLayer;

function haversineDistance(first, second) {
    const earthRadiusMeters = 6371000;
    const radians = Math.PI / 180;
    const latitudeDifference = (second[1] - first[1]) * radians;
    const longitudeDifference = (second[0] - first[0]) * radians;
    const latitudeOne = first[1] * radians;
    const latitudeTwo = second[1] * radians;
    const value =
        Math.sin(latitudeDifference / 2) ** 2 +
        Math.cos(latitudeOne) *
            Math.cos(latitudeTwo) *
            Math.sin(longitudeDifference / 2) ** 2;

    return 2 * earthRadiusMeters * Math.asin(Math.sqrt(value));
}

function parseCoordinates(coordinatesText) {
    return coordinatesText
        .trim()
        .split(/\s+/)
        .map((coordinate) => {
            const [longitude, latitude] = coordinate.split(",").map(Number);
            return [longitude, latitude];
        })
        .filter(
            (coordinate) =>
                Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1])
        );
}

function parseKml(kmlText) {
    const document = new DOMParser().parseFromString(kmlText, "application/xml");

    if (document.querySelector("parsererror")) {
        throw new Error("The accessibility map returned invalid KML.");
    }

    const features = [];
    const placemarks = Array.from(document.getElementsByTagName("Placemark"));

    placemarks.forEach((placemark) => {
        const name = placemark.getElementsByTagName("name")[0]?.textContent?.trim();
        const point = placemark.getElementsByTagName("Point")[0];
        const lineStrings = Array.from(placemark.getElementsByTagName("LineString"));

        if (point) {
            const coordinates = parseCoordinates(
                point.getElementsByTagName("coordinates")[0]?.textContent ?? ""
            );
            if (coordinates.length) {
                features.push({
                    type: "Feature",
                    properties: { name: name ?? "" },
                    geometry: { type: "Point", coordinates: coordinates[0] }
                });
            }
        }

        lineStrings.forEach((lineString) => {
            const coordinates = parseCoordinates(
                lineString.getElementsByTagName("coordinates")[0]?.textContent ?? ""
            );
            if (coordinates.length > 1) {
                features.push({
                    type: "Feature",
                    properties: { name: name ?? "" },
                    geometry: { type: "LineString", coordinates }
                });
            }
        });
    });

    return { type: "FeatureCollection", features };
}

function getBuildingName(name) {
    const normalized = name.trim().toLowerCase();
    const knownBuildings = {
        dealy: "Dealy Hall",
        duane: "Duane Library",
        "duane library": "Duane Library",
        "hughes hall": "Hughes Hall",
        hughes: "Hughes Hall",
        jmh: "John Mulcahy Hall",
        keating: "Keating Hall",
        library: "Duane Library",
        mcshane: "McShane"
    };

    if (
        !normalized ||
        normalized === "campus" ||
        normalized === "fordham" ||
        /^point\s+\d+$/i.test(normalized)
    ) {
        return null;
    }

    return (
        knownBuildings[normalized] ??
        (normalized === "441 e fordham rd" ? "Duane Library" : name.trim())
    );
}

function buildRouteGraph(features) {
    const segments = [];
    const vertices = [];
    const edges = [];
    const vertexBuckets = new Map();
    const bucketSizeDegrees = 0.00012;

    function bucketKey(coordinate) {
        return `${Math.round(coordinate[0] / bucketSizeDegrees)},${Math.round(
            coordinate[1] / bucketSizeDegrees
        )}`;
    }

    function findOrAddVertex(coordinate) {
        const [bucketX, bucketY] = bucketKey(coordinate).split(",").map(Number);
        const nearbyVertices = [];

        for (let x = bucketX - 1; x <= bucketX + 1; x += 1) {
            for (let y = bucketY - 1; y <= bucketY + 1; y += 1) {
                nearbyVertices.push(...(vertexBuckets.get(`${x},${y}`) ?? []));
            }
        }

        const nearby = nearbyVertices.find(
            (vertex) =>
                haversineDistance(vertex.coordinate, coordinate) <=
                routeJoinDistanceMeters
        );
        if (nearby) {
            return nearby.id;
        }

        const id = vertices.length;
        const vertex = { id, coordinate };
        vertices.push(vertex);
        edges.push([]);

        const key = bucketKey(coordinate);
        const bucket = vertexBuckets.get(key) ?? [];
        bucket.push(vertex);
        vertexBuckets.set(key, bucket);
        return id;
    }

    features.forEach((feature) => {
        if (feature.geometry?.type !== "LineString") {
            return;
        }

        const coordinates = feature.geometry.coordinates;
        for (let index = 0; index < coordinates.length - 1; index += 1) {
            const start = coordinates[index];
            const end = coordinates[index + 1];
            const startId = findOrAddVertex(start);
            const endId = findOrAddVertex(end);
            const distance = haversineDistance(start, end);

            if (startId !== endId && distance > 0) {
                edges[startId].push({ vertex: endId, distance });
                edges[endId].push({ vertex: startId, distance });
                segments.push({ start, end, startId, endId });
            }
        }
    });

    return { vertices, edges, segments };
}

function projectPointToSegment(point, start, end) {
    const latitudeScale = 111320;
    const longitudeScale = latitudeScale * Math.cos((point[1] * Math.PI) / 180);
    const toMeters = ([longitude, latitude]) => [
        longitude * longitudeScale,
        latitude * latitudeScale
    ];
    const pointMeters = toMeters(point);
    const startMeters = toMeters(start);
    const endMeters = toMeters(end);
    const deltaX = endMeters[0] - startMeters[0];
    const deltaY = endMeters[1] - startMeters[1];
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const fraction =
        lengthSquared === 0
            ? 0
            : Math.max(
                  0,
                  Math.min(
                      1,
                      ((pointMeters[0] - startMeters[0]) * deltaX +
                          (pointMeters[1] - startMeters[1]) * deltaY) /
                          lengthSquared
                  )
              );
    const projectedMeters = [
        startMeters[0] + fraction * deltaX,
        startMeters[1] + fraction * deltaY
    ];
    const projected = [
        projectedMeters[0] / longitudeScale,
        projectedMeters[1] / latitudeScale
    ];

    return {
        coordinate: projected,
        fraction,
        distance: haversineDistance(point, projected)
    };
}

function snapPointToRoute(point, graph) {
    let closest;

    graph.segments.forEach((segment) => {
        const projection = projectPointToSegment(point, segment.start, segment.end);
        if (!closest || projection.distance < closest.distance) {
            closest = {
                ...projection,
                segment,
                startDistance:
                    haversineDistance(segment.start, projection.coordinate),
                endDistance:
                    haversineDistance(projection.coordinate, segment.end)
            };
        }
    });

    return closest;
}

function findRoute(graph, startId, endId) {
    const distances = new Array(graph.vertices.length).fill(Infinity);
    const previous = new Array(graph.vertices.length).fill(null);
    const visited = new Set();
    distances[startId] = 0;

    while (visited.size < graph.vertices.length) {
        let current = -1;
        let shortestDistance = Infinity;

        for (let index = 0; index < distances.length; index += 1) {
            if (!visited.has(index) && distances[index] < shortestDistance) {
                current = index;
                shortestDistance = distances[index];
            }
        }

        if (current === -1 || current === endId) {
            break;
        }
        visited.add(current);

        graph.edges[current].forEach((edge) => {
            const candidateDistance = shortestDistance + edge.distance;
            if (candidateDistance < distances[edge.vertex]) {
                distances[edge.vertex] = candidateDistance;
                previous[edge.vertex] = current;
            }
        });
    }

    if (!Number.isFinite(distances[endId])) {
        return null;
    }

    const path = [];
    let current = endId;
    while (current !== null) {
        path.push(graph.vertices[current].coordinate);
        current = previous[current];
    }

    return { coordinates: path.reverse(), distance: distances[endId] };
}

function findShortestRoute(graph, start, end) {
    if (!start || !end) {
        return null;
    }

    const startCandidates = [
        { vertex: start.segment.startId, distance: start.startDistance },
        { vertex: start.segment.endId, distance: start.endDistance }
    ];
    const endCandidates = [
        { vertex: end.segment.startId, distance: end.startDistance },
        { vertex: end.segment.endId, distance: end.endDistance }
    ];
    let shortest =
        start.segment === end.segment
            ? {
                  coordinates: [start.coordinate, end.coordinate],
                  distance: haversineDistance(start.coordinate, end.coordinate),
                  direct: true
              }
            : null;

    startCandidates.forEach((startCandidate) => {
        endCandidates.forEach((endCandidate) => {
            const route = findRoute(
                graph,
                startCandidate.vertex,
                endCandidate.vertex
            );
            if (!route) {
                return;
            }

            const distance =
                startCandidate.distance + route.distance + endCandidate.distance;
            if (!shortest || distance < shortest.distance) {
                shortest = {
                    ...route,
                    distance,
                    direct: false,
                };
            }
        });
    });

    if (!shortest) {
        return null;
    }

    return {
        coordinates: shortest.direct
            ? shortest.coordinates
            : [start.coordinate, ...shortest.coordinates, end.coordinate],
        distance: shortest.distance,
        startCoordinate: start.coordinate,
        endCoordinate: end.coordinate
    };
}

function findAvailableBuildings(features, graph) {
    const buildingsByName = new Map();

    features.forEach((feature) => {
        if (feature.geometry?.type !== "Point") {
            return;
        }

        const name = getBuildingName(feature.properties?.name ?? "");
        if (!name || buildingsByName.has(name)) {
            return;
        }

        const coordinates = feature.geometry.coordinates;
        const snap = snapPointToRoute(coordinates, graph);
        if (snap && snap.distance <= buildingSnapDistanceMeters) {
            buildingsByName.set(name, { name, coordinates, snapDistance: snap.distance });
        }
    });

    return Array.from(buildingsByName.values()).sort((first, second) =>
        first.name.localeCompare(second.name)
    );
}

function createAccessibilityData(collection) {
    const graph = buildRouteGraph(collection.features);
    const buildings = findAvailableBuildings(collection.features, graph);
    const accessibilityLayer = L.geoJSON(collection, {
        style: (feature) =>
            feature.geometry?.type === "LineString"
                ? { color: "#0877a5", weight: 4, opacity: 0.82 }
                : { color: "#860038", weight: 2, fillOpacity: 0.82 },
        pointToLayer: (feature, latlng) =>
            L.circleMarker(latlng, {
                radius: 6,
                color: "#fff",
                weight: 2,
                fillColor: "#860038",
                fillOpacity: 1
            }).bindPopup(feature.properties?.name ?? "Campus location")
    });
    const buildingLayer = L.featureGroup();

    buildings.forEach((building) => {
        L.circleMarker([building.coordinates[1], building.coordinates[0]], {
            radius: 6,
            color: "#fff",
            weight: 2,
            fillColor: "#860038",
            fillOpacity: 1
        })
            .bindPopup(building.name)
            .addTo(buildingLayer);
    });

    return { accessibilityLayer, buildingLayer, buildings, graph };
}

async function loadAccessibilityData() {
    if (!accessibilityDataPromise) {
        accessibilityDataPromise = fetch(accessibilityKmlUrl)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(
                        `Unable to load the accessibility map (HTTP ${response.status}).`
                    );
                }
                return response.text();
            })
            .then(parseKml)
            .then(createAccessibilityData)
            .then((data) => {
                if (!data.buildings.length || !data.graph.segments.length) {
                    throw new Error(
                        "The accessibility map has no buildings or walking paths to route."
                    );
                }
                accessibilityData = data;
                return data;
            })
            .catch((error) => {
                accessibilityDataPromise = null;
                throw error;
            });
    }

    return accessibilityDataPromise;
}

function setBuildingOptions(buildings) {
    const placeholder = (label) => {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = label;
        return option;
    };

    [fromBuildingSelect, toBuildingSelect].forEach((select) => {
        select.replaceChildren(placeholder("Choose a building"));
        buildings.forEach((building) => {
            const option = document.createElement("option");
            option.value = building.name;
            option.textContent = building.name;
            select.append(option);
        });
        select.disabled = buildings.length === 0;
    });

    routeFields.setAttribute("aria-busy", "false");
}

function getSelectedBuildings() {
    const from = accessibilityData?.buildings.find(
        (building) => building.name === fromBuildingSelect.value
    );
    const to = accessibilityData?.buildings.find(
        (building) => building.name === toBuildingSelect.value
    );

    return {
        from,
        to,
        valid: Boolean(from && to && from.name !== to.name)
    };
}

function createGoogleDirectionsUrl(from, to) {
    const url = new URL(googleMapsDirectionsUrl);
    url.searchParams.set("api", "1");
    url.searchParams.set(
        "origin",
        `${from.coordinates[1]},${from.coordinates[0]}`
    );
    url.searchParams.set(
        "destination",
        `${to.coordinates[1]},${to.coordinates[0]}`
    );
    url.searchParams.set("travelmode", "walking");
    return url.toString();
}

function clearRoute() {
    if (routeLayer && map.hasLayer(routeLayer)) {
        map.removeLayer(routeLayer);
    }
    routeLayer = undefined;
}

function updateSelectedBuildingMarkers(from, to, valid) {
    selectionLayer.clearLayers();
    if (valid) {
        L.circleMarker([from.coordinates[1], from.coordinates[0]], {
            radius: 8,
            color: "#fff",
            weight: 3,
            fillColor: "#0877a5",
            fillOpacity: 1
        })
            .bindPopup(`From: ${from.name}`)
            .addTo(selectionLayer);
        L.circleMarker([to.coordinates[1], to.coordinates[0]], {
            radius: 8,
            color: "#fff",
            weight: 3,
            fillColor: "#c96a3d",
            fillOpacity: 1
        })
            .bindPopup(`To: ${to.name}`)
            .addTo(selectionLayer);
    }

    if (map.hasLayer(selectionLayer)) {
        map.removeLayer(selectionLayer);
    }
    selectionLayer.addTo(map);
}

function fitActiveLayer() {
    if (routeLayer?.getLayers().length) {
        map.fitBounds(routeLayer.getBounds(), { padding: [28, 28] });
        return;
    }
    if (selectionLayer.getLayers().length) {
        map.fitBounds(selectionLayer.getBounds(), { padding: [40, 40] });
        return;
    }
    if (activeLayer?.getBounds && activeLayer.getLayers().length) {
        map.fitBounds(activeLayer.getBounds(), { padding: [24, 24] });
    }
}

function resetMapView() {
    if (routeLayer?.getLayers().length) {
        map.fitBounds(routeLayer.getBounds(), { padding: [28, 28] });
        return;
    }
    if (activeLayer?.getBounds && activeLayer.getLayers().length) {
        map.fitBounds(activeLayer.getBounds(), { padding: [24, 24] });
        return;
    }
    map.setView([40.861, -73.885], 16);
}

function updateRouteControls(fitSelection = true) {
    const { from, to, valid } = getSelectedBuildings();
    const accessibilityMode = accessibilityToggle.checked;

    routeButton.hidden = !accessibilityMode;
    routeButton.disabled = !valid;
    googleRouteLink.hidden = accessibilityMode || !valid;
    if (valid) {
        googleRouteLink.href = createGoogleDirectionsUrl(from, to);
        routeStatus.textContent = accessibilityMode
            ? `Ready to show the accessible route from ${from.name} to ${to.name}.`
            : `Open Google Maps for a walking route from ${from.name} to ${to.name}.`;
    } else {
        googleRouteLink.removeAttribute("href");
        routeStatus.textContent =
            from && to
                ? "Choose different buildings for the start and destination."
                : "Choose a starting building and a destination.";
    }

    updateSelectedBuildingMarkers(from, to, valid);
    if (fitSelection && valid && !routeLayer) {
        fitActiveLayer();
    }
}

async function updateMapMode() {
    const useAccessibilityMap = accessibilityToggle.checked;
    clearRoute();
    mapModeError.hidden = true;
    mapStatus.textContent = "Loading campus locations…";

    try {
        const data = await loadAccessibilityData();
        if (accessibilityToggle.checked !== useAccessibilityMap) {
            return false;
        }

        const nextLayer = useAccessibilityMap
            ? data.accessibilityLayer
            : data.buildingLayer;
        if (activeLayer && map.hasLayer(activeLayer)) {
            map.removeLayer(activeLayer);
        }
        nextLayer.addTo(map);
        activeLayer = nextLayer;
        mapStatus.textContent = useAccessibilityMap
            ? "Accessibility map enabled"
            : "Campus map enabled";
        updateRouteControls(false);
        fitActiveLayer();
        return true;
    } catch (error) {
        console.error("Unable to change map mode:", error);
        mapModeError.textContent =
            error instanceof Error
                ? error.message
                : "The map could not be loaded. Please try again.";
        mapModeError.hidden = false;
        mapStatus.textContent = "Map data could not be loaded";
        return false;
    }
}

function showAccessibilityRoute() {
    const { from, to, valid } = getSelectedBuildings();
    if (!accessibilityToggle.checked || !valid || !accessibilityData) {
        return;
    }

    const start = snapPointToRoute(from.coordinates, accessibilityData.graph);
    const end = snapPointToRoute(to.coordinates, accessibilityData.graph);
    if (
        !start ||
        !end ||
        start.distance > buildingSnapDistanceMeters ||
        end.distance > buildingSnapDistanceMeters
    ) {
        routeStatus.textContent =
            "One or both buildings are not close enough to an accessibility path.";
        return;
    }

    const route = findShortestRoute(accessibilityData.graph, start, end);
    if (!route) {
        routeStatus.textContent =
            "No connected accessibility route is available between these buildings.";
        return;
    }

    clearRoute();
    selectionLayer.clearLayers();
    const routeCoordinates = route.coordinates.map((coordinate) => [
        coordinate[1],
        coordinate[0]
    ]);
    const layers = [
        L.polyline(routeCoordinates, {
            color: "#c96a3d",
            weight: 7,
            opacity: 0.95,
            lineCap: "round",
            lineJoin: "round"
        }),
        L.polyline(
            [
                [from.coordinates[1], from.coordinates[0]],
                [route.startCoordinate[1], route.startCoordinate[0]]
            ],
            {
                color: "#0877a5",
                weight: 4,
                opacity: 0.85,
                dashArray: "6 7"
            }
        ),
        L.polyline(
            [
                [route.endCoordinate[1], route.endCoordinate[0]],
                [to.coordinates[1], to.coordinates[0]]
            ],
            {
                color: "#0877a5",
                weight: 4,
                opacity: 0.85,
                dashArray: "6 7"
            }
        ),
        L.circleMarker([from.coordinates[1], from.coordinates[0]], {
            radius: 8,
            color: "#fff",
            weight: 3,
            fillColor: "#0877a5",
            fillOpacity: 1
        }).bindPopup(`From: ${from.name}`),
        L.circleMarker([to.coordinates[1], to.coordinates[0]], {
            radius: 8,
            color: "#fff",
            weight: 3,
            fillColor: "#c96a3d",
            fillOpacity: 1
        }).bindPopup(`To: ${to.name}`)
    ];

    routeLayer = L.featureGroup(layers).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    routeStatus.textContent = `Accessible route from ${from.name} to ${to.name} is shown. Mapped path distance: approximately ${Math.round(route.distance)} m.`;
}

async function initialize() {
    routeFields.setAttribute("aria-busy", "true");
    fromBuildingSelect.disabled = true;
    toBuildingSelect.disabled = true;

    try {
        const data = await loadAccessibilityData();
        setBuildingOptions(data.buildings);

        const useAccessibilityMap = accessibilityToggle.checked;
        activeLayer = useAccessibilityMap
            ? data.accessibilityLayer
            : data.buildingLayer;
        activeLayer.addTo(map);
        mapStatus.textContent = useAccessibilityMap
            ? "Accessibility map enabled"
            : "Campus map enabled";
        updateRouteControls(false);
        fitActiveLayer();
    } catch (error) {
        console.error("Unable to initialize the campus map:", error);
        const message =
            error instanceof Error
                ? error.message
                : "The campus map could not be loaded. Please refresh to try again.";
        mapStatus.textContent = "Map data could not be loaded";
        mapModeError.textContent = message;
        mapModeError.hidden = false;
        setBuildingOptions([]);
        fromBuildingSelect.replaceChildren(
            new Option("Building list unavailable", "")
        );
        toBuildingSelect.replaceChildren(
            new Option("Building list unavailable", "")
        );
        routeStatus.textContent = "Building choices could not be loaded.";
    }
}

accessibilityToggle.addEventListener("change", updateMapMode);
resetViewButton.addEventListener("click", resetMapView);
fromBuildingSelect.addEventListener("change", () => {
    clearRoute();
    updateRouteControls();
});
toBuildingSelect.addEventListener("change", () => {
    clearRoute();
    updateRouteControls();
});
routeButton.addEventListener("click", showAccessibilityRoute);

initialize();
