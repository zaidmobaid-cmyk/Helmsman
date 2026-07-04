// HELMSMAN — marine chart plotter for Expo Go
// Paste this into App.js at snack.expo.dev
// When Snack prompts about missing packages, tap "Add dependency" for:
//   react-native-maps, expo-location, @react-native-async-storage/async-storage

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Vibration,
  TextInput, ScrollView, Platform,
} from 'react-native';
import MapView, { Marker, Polyline, Circle, UrlTile } from 'react-native-maps';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ---------- nav math ---------- */
const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const distNM = (a, b) => distM(a, b) / 1852;
function brg(a, b) {
  const y = Math.sin(toRad(b.longitude - a.longitude)) * Math.cos(toRad(b.latitude));
  const x = Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) *
    Math.cos(toRad(b.longitude - a.longitude));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function fmtPos(lat, lon) {
  const f = (v, p, n) => {
    const h = v >= 0 ? p : n; v = Math.abs(v);
    const d = Math.floor(v); const m = (v - d) * 60;
    return `${String(d).padStart(2, '0')}°${m.toFixed(3)}'${h}`;
  };
  return [f(lat, 'N', 'S'), f(lon, 'E', 'W')];
}
const fmtBrg = (b) => String(Math.round(b)).padStart(3, '0') + '°';

/* ---------- colors ---------- */
const C = {
  chrome: '#0A1620', cell: '#101F2B', line: '#1D3140',
  data: '#EAF4F8', label: '#6E8899', cyan: '#35C4DC',
  gold: '#F5B84C', red: '#FF4F58', green: '#4CD98A',
};

export default function App() {
  const mapRef = useRef(null);
  const [fix, setFix] = useState(null);           // {latitude, longitude}
  const [sog, setSog] = useState(0);
  const [cog, setCog] = useState(0);
  const [follow, setFollow] = useState(true);
  const [status, setStatus] = useState('Acquiring GPS');

  const [routeMode, setRouteMode] = useState(false);
  const [wps, setWps] = useState([]);
  const [speed, setSpeed] = useState('18');
  const [savedList, setSavedList] = useState(null); // null = hidden

  const [tracking, setTracking] = useState(false);
  const [trackPts, setTrackPts] = useState([]);

  const [anchor, setAnchor] = useState(null);
  const [anchorRad, setAnchorRad] = useState(40);
  const [drift, setDrift] = useState(null);
  const [alarm, setAlarm] = useState(false);

  const [mob, setMob] = useState(null);
  const [night, setNight] = useState(false);
  const [depth, setDepth] = useState(true); // EMODnet bathymetry layer
  const [panel, setPanel] = useState(null); // 'route' | 'anchor' | 'mob' | null

  const stateRef = useRef({});
  stateRef.current = { tracking, anchor, anchorRad, alarm, follow };

  /* ---------- GPS ---------- */
  useEffect(() => {
    let sub;
    (async () => {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') { setStatus('No GPS permission'); return; }
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2 },
        (loc) => {
          const pt = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
          const kn = loc.coords.speed != null && loc.coords.speed >= 0
            ? loc.coords.speed * 1.94384 : 0;
          setSog(kn);
          if (loc.coords.heading != null && loc.coords.heading >= 0 && kn > 0.5)
            setCog(loc.coords.heading);
          setFix(pt);
          setStatus('GPS fix');
          const S = stateRef.current;
          if (S.follow && mapRef.current)
            mapRef.current.animateCamera({ center: pt }, { duration: 400 });
          // track
          if (S.tracking)
            setTrackPts((prev) => {
              const last = prev[prev.length - 1];
              return !last || distM(last, pt) > 6 ? [...prev, pt] : prev;
            });
          // anchor watch
          if (S.anchor) {
            const d = distM(S.anchor, pt);
            setDrift(Math.round(d));
            if (d > S.anchorRad && !S.alarm) {
              setAlarm(true);
              Vibration.vibrate([400, 400], true);
            } else if (d <= S.anchorRad && S.alarm) {
              setAlarm(false); Vibration.cancel();
            }
          }
        }
      );
    })();
    return () => { sub && sub.remove(); Vibration.cancel(); };
  }, []);

  /* ---------- route ---------- */
  const onMapPress = (e) => {
    if (routeMode) setWps([...wps, e.nativeEvent.coordinate]);
  };
  let totalNM = 0; const legs = [];
  for (let i = 1; i < wps.length; i++) {
    const d = distNM(wps[i - 1], wps[i]); totalNM += d;
    legs.push(`WP${i}→${i + 1}  ${d.toFixed(2)} NM  ${fmtBrg(brg(wps[i - 1], wps[i]))}`);
  }
  const spd = parseFloat(speed) || 1;
  const etaH = totalNM / spd;
  const eta = totalNM > 0
    ? `${Math.floor(etaH)}h ${String(Math.round((etaH % 1) * 60)).padStart(2, '0')}m` : '—';

  const saveRoute = async () => {
    if (!wps.length) return;
    const idx = JSON.parse((await AsyncStorage.getItem('routes')) || '[]');
    idx.push({ name: `Route ${idx.length + 1} · ${new Date().toLocaleDateString()}`, wps });
    await AsyncStorage.setItem('routes', JSON.stringify(idx));
    setStatus('Route saved'); setTimeout(() => setStatus('GPS fix'), 1500);
  };
  const showSaved = async () => {
    if (savedList) { setSavedList(null); return; }
    setSavedList(JSON.parse((await AsyncStorage.getItem('routes')) || '[]'));
  };
  const deleteSaved = async (i) => {
    const idx = savedList.filter((_, j) => j !== i);
    await AsyncStorage.setItem('routes', JSON.stringify(idx));
    setSavedList(idx);
  };

  /* ---------- anchor ---------- */
  const dropAnchor = () => { if (fix) { setAnchor(fix); setDrift(0); } };
  const stopAnchor = () => { setAnchor(null); setAlarm(false); setDrift(null); Vibration.cancel(); };

  /* ---------- MOB ---------- */
  const markMob = () => {
    if (!fix) return;
    setMob({ pt: fix, t: new Date() });
    Vibration.vibrate(600);
    setPanel('mob');
  };

  const [pa, pb] = fix ? fmtPos(fix.latitude, fix.longitude) : ['NO FIX', ''];
  const D = night ? '#FF7B72' : C.data;   // night-vision red
  const L = night ? '#8f3f3c' : C.label;

  return (
    <View style={s.root}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={{ latitude: 51.62, longitude: 0.81, latitudeDelta: 0.25, longitudeDelta: 0.25 }}
        onPress={onMapPress}
        onPanDrag={() => setFollow(false)}
        showsCompass
        mapType={night ? 'mutedStandard' : 'standard'}
      >
        {depth && (
          <UrlTile
            urlTemplate="https://tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png"
            zIndex={3}
            maximumZ={12}
          />
        )}
        <UrlTile urlTemplate="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png" zIndex={5} maximumZ={18} />
        {fix && (
          <Marker coordinate={fix} anchor={{ x: 0.5, y: 0.5 }} flat rotation={cog}>
            <View style={s.boat} />
          </Marker>
        )}
        {wps.map((w, i) => (
          <Marker key={i} coordinate={w} anchor={{ x: 0.5, y: 0.5 }}
            draggable onDragEnd={(e) => {
              const n = [...wps]; n[i] = e.nativeEvent.coordinate; setWps(n);
            }}>
            <View style={s.wp}><Text style={s.wpTxt}>{i + 1}</Text></View>
          </Marker>
        ))}
        {wps.length > 1 && <Polyline coordinates={wps} strokeColor={C.gold} strokeWidth={3} lineDashPattern={[8, 6]} />}
        {trackPts.length > 1 && <Polyline coordinates={trackPts} strokeColor={C.green} strokeWidth={2.5} />}
        {anchor && <Circle center={anchor} radius={anchorRad} strokeColor={C.red} fillColor="rgba(255,79,88,0.08)" strokeWidth={2} />}
        {mob && (
          <Marker coordinate={mob.pt} anchor={{ x: 0.5, y: 0.5 }}>
            <View style={s.mobDot} />
          </Marker>
        )}
      </MapView>

      {night && <View pointerEvents="none" style={s.nightTint} />}
      {alarm && <View pointerEvents="none" style={s.alarmFlash} />}

      {/* top bar */}
      <View style={s.top}>
        <Text style={[s.brand, { color: D }]}>HELMS<Text style={{ color: night ? D : C.cyan }}>MAN</Text></Text>
        <View style={[s.dot, { backgroundColor: fix ? C.green : C.gold }]} />
        <Text style={[s.status, { color: L }]}>{alarm ? '⚠ DRAGGING' : status}</Text>
      </View>

      {/* right rail */}
      <View style={s.rail}>
        <Rail label="MOB" color={C.red} onPress={markMob} />
        <Rail label="◎" color={follow ? C.cyan : D} onPress={() => {
          setFollow(true);
          if (fix && mapRef.current) mapRef.current.animateCamera({ center: fix, zoom: 14 });
        }} />
        <Rail label="≋" color={depth ? C.cyan : D} onPress={() => setDepth(!depth)} />
        <Rail label="☾" color={night ? C.red : D} onPress={() => setNight(!night)} />
      </View>

      {/* mode chips */}
      <View style={s.modes}>
        <Chip txt="ROUTE" on={routeMode} color={C.gold}
          onPress={() => { setRouteMode(!routeMode); setPanel(!routeMode ? 'route' : null); }} />
        <Chip txt="TRACK" on={tracking} color={C.green}
          onPress={() => setTracking(!tracking)} />
        <Chip txt="ANCHOR" on={!!anchor} color={C.red}
          onPress={() => setPanel(panel === 'anchor' ? null : 'anchor')} />
      </View>

      {/* panels */}
      {panel === 'route' && (
        <View style={s.panel}>
          <Text style={s.pTitle}>ROUTE PLAN</Text>
          <Row k="Distance" v={`${totalNM.toFixed(1)} NM`} />
          <View style={s.etaRow}>
            <Text style={s.rowK}>ETA @</Text>
            <TextInput style={s.spdIn} keyboardType="numeric" value={speed} onChangeText={setSpeed} />
            <Text style={s.rowK}>kn</Text>
            <Text style={[s.rowV, { marginLeft: 'auto' }]}>{eta}</Text>
          </View>
          <ScrollView style={{ maxHeight: 90 }}>
            {legs.length
              ? legs.map((l, i) => <Text key={i} style={s.leg}>{l}</Text>)
              : <Text style={s.leg}>Tap the chart to drop waypoints. Drag to adjust.</Text>}
          </ScrollView>
          <View style={s.btnRow}>
            <Btn t="UNDO" onPress={() => setWps(wps.slice(0, -1))} />
            <Btn t="CLEAR" c={C.red} onPress={() => setWps([])} />
            <Btn t="SAVE" c={C.gold} onPress={saveRoute} />
            <Btn t="SAVED" c={C.cyan} onPress={showSaved} />
          </View>
          {savedList && savedList.map((r, i) => (
            <View key={i} style={s.savedRow}>
              <TouchableOpacity style={{ flex: 1 }} onPress={() => {
                setWps(r.wps); setSavedList(null);
                if (mapRef.current) mapRef.current.fitToCoordinates(r.wps, { edgePadding: { top: 80, bottom: 200, left: 40, right: 40 } });
              }}>
                <Text style={{ color: C.data }}>{r.name} ({r.wps.length} wp)</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteSaved(i)}>
                <Text style={{ color: C.red, padding: 4 }}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
          {savedList && !savedList.length && <Text style={s.leg}>No saved routes yet.</Text>}
        </View>
      )}

      {panel === 'anchor' && (
        <View style={s.panel}>
          <Text style={s.pTitle}>ANCHOR WATCH</Text>
          <Row k="Swing radius" v={`${anchorRad} m`} />
          <View style={s.btnRow}>
            <Btn t="−10" onPress={() => setAnchorRad(Math.max(15, anchorRad - 10))} />
            <Btn t="+10" onPress={() => setAnchorRad(Math.min(200, anchorRad + 10))} />
          </View>
          <Row k="Drift" v={drift != null ? `${drift} m` : '—'} />
          <View style={s.btnRow}>
            <Btn t="DROP ANCHOR HERE" c={C.cyan} onPress={dropAnchor} />
            <Btn t="STOP" c={C.red} onPress={stopAnchor} />
          </View>
        </View>
      )}

      {panel === 'mob' && mob && (
        <View style={[s.panel, { borderColor: C.red }]}>
          <Text style={[s.pTitle, { color: C.red }]}>MAN OVERBOARD</Text>
          <Row k="Marked" v={mob.t.toTimeString().slice(0, 8)} />
          <Row k="Range" v={fix ? `${distNM(fix, mob.pt).toFixed(2)} NM (${Math.round(distM(fix, mob.pt))} m)` : '—'} />
          <Row k="Bearing" v={fix ? fmtBrg(brg(fix, mob.pt)) : '—'} />
          <View style={s.btnRow}>
            <Btn t="CLEAR MOB" c={C.red} onPress={() => { setMob(null); setPanel(null); }} />
          </View>
        </View>
      )}

      {/* instrument bar */}
      <View style={s.instr}>
        <Cell lab="SOG" val={sog.toFixed(1)} unit="KN" d={D} l={L} />
        <Cell lab="COG" val={fmtBrg(cog)} unit="TRUE" d={D} l={L} />
        <View style={s.cellWide}>
          <Text style={[s.cLab, { color: L }]}>POSITION</Text>
          <Text style={[s.cPos, { color: D }]}>{pa}</Text>
          <Text style={[s.cPos, { color: D }]}>{pb}</Text>
        </View>
      </View>
    </View>
  );
}

/* ---------- small components ---------- */
const Rail = ({ label, color, onPress }) => (
  <TouchableOpacity style={[s.rbtn, { borderColor: color }]} onPress={onPress}>
    <Text style={{ color, fontWeight: '700', fontSize: label.length > 2 ? 13 : 20 }}>{label}</Text>
  </TouchableOpacity>
);
const Chip = ({ txt, on, color, onPress }) => (
  <TouchableOpacity style={[s.chip, on && { borderColor: color }]} onPress={onPress}>
    <View style={[s.chipDot, { backgroundColor: on ? color : C.label }]} />
    <Text style={{ color: on ? color : C.data, fontWeight: '700', letterSpacing: 1.5 }}>{txt}</Text>
  </TouchableOpacity>
);
const Btn = ({ t, c = C.data, onPress }) => (
  <TouchableOpacity style={[s.btn, { borderColor: c === C.data ? C.line : c }]} onPress={onPress}>
    <Text style={{ color: c, fontWeight: '700', fontSize: 12, letterSpacing: 1 }}>{t}</Text>
  </TouchableOpacity>
);
const Row = ({ k, v }) => (
  <View style={s.row}><Text style={s.rowK}>{k}</Text><Text style={s.rowV}>{v}</Text></View>
);
const Cell = ({ lab, val, unit, d, l }) => (
  <View style={s.cell}>
    <Text style={[s.cLab, { color: l }]}>{lab}</Text>
    <Text style={[s.cVal, { color: d }]}>{val}</Text>
    <Text style={[s.cUnit, { color: l }]}>{unit}</Text>
  </View>
);

/* ---------- styles ---------- */
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.chrome },
  top: {
    position: 'absolute', top: Platform.OS === 'ios' ? 54 : 40, left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  brand: { fontWeight: '800', letterSpacing: 3, fontSize: 15 },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 },
  status: { fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase' },
  rail: { position: 'absolute', right: 10, top: '32%', gap: 10 },
  rbtn: {
    width: 52, height: 52, borderRadius: 12, borderWidth: 1,
    backgroundColor: 'rgba(16,31,43,0.94)', alignItems: 'center', justifyContent: 'center',
  },
  modes: { position: 'absolute', left: 10, bottom: 118, gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10,
    paddingHorizontal: 16, borderRadius: 24, borderWidth: 1, borderColor: C.line,
    backgroundColor: 'rgba(16,31,43,0.94)',
  },
  chipDot: { width: 9, height: 9, borderRadius: 5 },
  panel: {
    position: 'absolute', left: 10, right: 72, bottom: 118,
    backgroundColor: 'rgba(10,22,32,0.97)', borderWidth: 1, borderColor: C.line,
    borderRadius: 14, padding: 14, maxHeight: 340,
  },
  pTitle: { color: C.label, fontSize: 12, letterSpacing: 2.5, fontWeight: '700', marginBottom: 8 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line,
  },
  rowK: { color: C.label, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' },
  rowV: { color: C.data, fontSize: 15, fontVariant: ['tabular-nums'] },
  etaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5 },
  spdIn: {
    backgroundColor: C.cell, borderWidth: 1, borderColor: C.line, borderRadius: 8,
    color: C.data, paddingHorizontal: 8, paddingVertical: 3, width: 52, textAlign: 'center',
  },
  leg: { color: C.label, fontSize: 12.5, lineHeight: 20, fontVariant: ['tabular-nums'] },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  btn: {
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 9, borderWidth: 1,
    backgroundColor: C.cell,
  },
  savedRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: C.line,
  },
  instr: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row',
    backgroundColor: C.line, gap: StyleSheet.hairlineWidth, borderTopWidth: 1,
    borderColor: C.line, paddingBottom: Platform.OS === 'ios' ? 18 : 0,
  },
  cell: { flex: 1, backgroundColor: C.cell, alignItems: 'center', paddingVertical: 8 },
  cellWide: { flex: 1.6, backgroundColor: C.cell, alignItems: 'center', paddingVertical: 8 },
  cLab: { fontSize: 10, letterSpacing: 2 },
  cVal: { fontSize: 26, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cUnit: { fontSize: 10, letterSpacing: 1 },
  cPos: { fontSize: 13.5, fontVariant: ['tabular-nums'], lineHeight: 19 },
  boat: {
    width: 0, height: 0, borderLeftWidth: 10, borderRightWidth: 10, borderBottomWidth: 26,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: C.cyan,
  },
  wp: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: C.gold,
    borderWidth: 2, borderColor: C.chrome, alignItems: 'center', justifyContent: 'center',
  },
  wpTxt: { color: C.chrome, fontWeight: '800', fontSize: 11 },
  mobDot: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: C.red,
    borderWidth: 2, borderColor: '#fff',
  },
  nightTint: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(120,0,0,0.35)' },
  alarmFlash: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,79,88,0.25)' },
});
