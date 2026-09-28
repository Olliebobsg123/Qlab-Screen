// Cue lights: the stage manager puts a department on standby for a cue, the department
// acknowledges ("standing by"), then the stage manager gives the GO. One light per department.
const GO_SHOWS_FOR_MS = 6000;
const lights = new Map();
const goTimers = new Map();

export function publicCueLights() {
  return Object.fromEntries(lights);
}

// state: "standby" | "ready" | "go" | "clear". onChange is called when a GO clears itself.
export function setCueLight(departmentId, lightState, { cue = "", by = "" } = {}, onChange = () => {}) {
  clearTimeout(goTimers.get(departmentId));
  goTimers.delete(departmentId);
  if (lightState === "clear") {
    lights.delete(departmentId);
    return null;
  }
  const previous = lights.get(departmentId);
  const light = {
    state: lightState,
    cue: String(cue || previous?.cue || "").slice(0, 60),
    by: String(by || previous?.by || "").slice(0, 40),
    at: Date.now()
  };
  lights.set(departmentId, light);
  if (lightState === "go") {
    goTimers.set(departmentId, setTimeout(() => {
      if (lights.get(departmentId) === light) {
        lights.delete(departmentId);
        onChange();
      }
    }, GO_SHOWS_FOR_MS));
  }
  return light;
}

export function getCueLight(departmentId) {
  return lights.get(departmentId) || null;
}
