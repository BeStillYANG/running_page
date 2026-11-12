import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import * as polyline from '@mapbox/polyline';
import type { Activity } from '../types';
import { hasRoute, routeForActivity } from '../core/routeFallback';
import { MAPBOX_TOKEN } from '../config';
import { useLocale } from '../hooks/useLocale';
import './RouteMap.css';

export interface RouteMapProps {
  activities: Activity[];
  allActivities?: Activity[];
  selectedActivity?: Activity | null;
  dark?: boolean;
  onClearSelection?: () => void;
}

type BasemapProvider = 'mapbox' | 'amap' | 'carto';

// 高德栅格底图：国内直连、无需 token。其坐标系为 GCJ-02，
// 所以绘制轨迹时要把 GPS 原始坐标（WGS-84）做一次偏移修正。
const AMAP_STYLE = {
  version: 8,
  sources: {
    amap: {
      type: 'raster',
      tiles: [
        'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        'https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        'https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        'https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
      ],
      tileSize: 256,
      attribution: '\u00a9 \u9ad8\u5fb7\u5730\u56fe AutoNavi',
    },
  },
  layers: [{ id: 'amap-base', type: 'raster', source: 'amap' }],
};

const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lng: number, lat: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number) {
  let ret =
    -100.0 +
    2.0 * x +
    3.0 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * Math.PI) +
      20.0 * Math.sin(2.0 * x * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) +
      320 * Math.sin((y * Math.PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(x: number, y: number) {
  let ret =
    300.0 +
    x +
    2.0 * y +
    0.1 * x * x +
    0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret +=
    ((20.0 * Math.sin(6.0 * x * Math.PI) +
      20.0 * Math.sin(2.0 * x * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) *
      2.0) /
    3.0;
  ret +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) +
      300.0 * Math.sin((x / 30.0) * Math.PI)) *
      2.0) /
    3.0;
  return ret;
}

/** WGS-84（GPS 原始坐标）-> GCJ-02（高德底图坐标） */
function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat =
    (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

const routeCache = new WeakMap<
  Activity,
  {
    type: 'Feature';
    properties: { type: string };
    geometry: { type: 'LineString'; coordinates: number[][] };
  }[]
>();

export function RouteMapCanvas({
  activities,
  allActivities = activities,
  selectedActivity,
  dark,
  onClearSelection,
}: RouteMapProps) {
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const panelRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const styleReadyRef = useRef(false);
  const cameraRef = useRef<mapboxgl.CameraOptions | null>(null);
  const fittedRef = useRef<unknown>(null);
  const [provider, setProvider] = useState<BasemapProvider>(
    MAPBOX_TOKEN ? 'mapbox' : 'amap'
  );
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [retry, setRetry] = useState(0);
  const tileErrorCountRef = useRef(0);
  const style: any =
    provider === 'mapbox'
      ? `mapbox://styles/mapbox/${dark === false ? 'light' : 'dark'}-v11`
      : provider === 'amap'
        ? AMAP_STYLE
        : `https://basemaps.cartocdn.com/gl/${dark === false ? 'positron' : 'dark-matter'}-gl-style/style.json`;

  const displayActivity = useMemo(
    () =>
      selectedActivity
        ? routeForActivity(selectedActivity, allActivities)
        : null,
    [selectedActivity, allActivities]
  );
  const fallbackActivity =
    selectedActivity && !hasRoute(selectedActivity) ? displayActivity : null;

  const routes = useMemo(() => {
    const items = selectedActivity
      ? displayActivity
        ? [displayActivity]
        : []
      : activities;
    const features = items.flatMap((activity) => {
      const cached = routeCache.get(activity);
      if (cached) return cached;
      if (!activity.summary_polyline) return [];
      try {
        const coordinates = polyline
          .decode(activity.summary_polyline)
          .map(([lat, lng]) => [lng, lat])
          .filter(
            ([lng, lat]) =>
              Number.isFinite(lng) &&
              Number.isFinite(lat) &&
              Math.abs(lng) <= 180 &&
              Math.abs(lat) <= 90
          );
        if (coordinates.length < 2) return [];
        const features = [
          {
            type: 'Feature' as const,
            properties: { type: activity.type },
            geometry: { type: 'LineString' as const, coordinates },
          },
        ];
        routeCache.set(activity, features);
        return features;
      } catch {
        return [];
      }
    });
    if (provider !== 'amap') return features;
    return features.map((feature) => ({
      ...feature,
      geometry: {
        type: 'LineString' as const,
        coordinates: feature.geometry.coordinates.map(([lng, lat]) =>
          wgs84ToGcj02(lng, lat)
        ),
      },
    }));
  }, [activities, selectedActivity, displayActivity, provider]);

  const routeBounds = useMemo(() => {
    const bounds = new mapboxgl.LngLatBounds();
    for (const route of routes) {
      for (const coord of route.geometry.coordinates)
        bounds.extend(coord as [number, number]);
    }
    return bounds;
  }, [routes]);

  const fitRoutes = useCallback(() => {
    const map = mapRef.current;
    if (!map || routeBounds.isEmpty()) return;
    map.fitBounds(routeBounds, {
      padding: { top: 35, bottom: 35, left: 35, right: 65 },
      maxZoom: selectedActivity ? 16 : 13,
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : 500,
    });
  }, [routeBounds, selectedActivity]);

  const drawRoutes = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    const data = { type: 'FeatureCollection' as const, features: routes };
    const source = map.getSource('routes') as
      mapboxgl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else {
      map.addSource('routes', { type: 'geojson', data });
      map.addLayer({
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'type'],
            'Run',
            '#f97316',
            'Ride',
            '#3b82f6',
            '#4dd2ff',
          ],
        },
      });
    }
    map.setPaintProperty('routes', 'line-width', selectedActivity ? 3.5 : 2);
    map.setPaintProperty('routes', 'line-opacity', selectedActivity ? 1 : 0.7);
    if (fittedRef.current !== routes) {
      fittedRef.current = routes;
      fitRoutes();
    }
  }, [routes, selectedActivity, fitRoutes]);

  useEffect(() => {
    if (!containerRef.current || !panelRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      accessToken: MAPBOX_TOKEN || 'pk.runpage-placeholder',
      language: zh ? 'zh-Hans' : 'en',
      style: { version: 8, sources: {}, layers: [] },
      center: [121.4, 31.2],
      zoom: 10,
      ...cameraRef.current,
      locale: zh
        ? {
            'Map.Title': '跑步路线地图',
            'NavigationControl.ZoomIn': '放大',
            'NavigationControl.ZoomOut': '缩小',
            'NavigationControl.ResetBearing': '恢复朝北',
            'FullscreenControl.Enter': '全屏查看',
            'FullscreenControl.Exit': '退出全屏',
            'AttributionControl.ToggleAttribution': '地图来源',
          }
        : {},
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(
      new mapboxgl.FullscreenControl({ container: panelRef.current }),
      'top-right'
    );
    map.addControl(
      new mapboxgl.ScaleControl({ unit: 'metric', maxWidth: 90 }),
      'bottom-left'
    );
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);
    return () => {
      cameraRef.current = {
        center: map.getCenter(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
      observer.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [zh]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let failed = false;
    tileErrorCountRef.current = 0;
    const onError = (event: mapboxgl.ErrorEvent) => {
      const err = event.error as
        | (Error & { status?: number; url?: string })
        | undefined;
      const code = err?.status;
      const url = err?.url || '';
      if (provider === 'mapbox' && (code === 401 || code === 403)) {
        setProvider('amap');
        return;
      }
      // 占位 token 触发的 Mapbox 遥测/鉴权噪音（events/map-sessions），
      // 与当前底图（高德瓦片）无关，直接忽略，避免误报"底图加载失败"。
      if (typeof url === 'string' && /mapbox\.(com|cn)/.test(url)) return;
      if (code === 401 || code === 403) return;
      console.warn('[RouteMap] basemap error', code, url, err?.message);
      // 只有持续多次的真实瓦片错误才判定为加载失败
      tileErrorCountRef.current += 1;
      if (tileErrorCountRef.current >= 6) {
        failed = true;
        setStatus('error');
      }
    };
    const onIdle = () => {
      if (!failed) setStatus('ready');
    };
    const onLoading = () => setStatus('loading');
    map.on('error', onError);
    map.on('idle', onIdle);
    map.once('styledataloading', onLoading);
    styleReadyRef.current = false;
    map.setStyle(style, {
      diff: false,
      localFontFamily: undefined,
      localIdeographFontFamily: 'sans-serif',
    });
    const timer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) setStatus('error');
    }, 15000);
    return () => {
      window.clearTimeout(timer);
      map.off('error', onError);
      map.off('idle', onIdle);
      map.off('styledataloading', onLoading);
    };
  }, [style, provider, retry, zh]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onStyleLoad = () => {
      styleReadyRef.current = true;
      drawRoutes();
    };
    map.on('style.load', onStyleLoad);
    drawRoutes();
    return () => {
      map.off('style.load', onStyleLoad);
    };
  }, [drawRoutes, style, retry, zh]);

  useEffect(() => {
    let wasFullscreen = document.fullscreenElement === panelRef.current;
    let frame = 0;
    const onFullscreen = () => {
      const isFullscreen = document.fullscreenElement === panelRef.current;
      if (isFullscreen || wasFullscreen) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          mapRef.current?.resize();
          fitRoutes();
        });
      }
      wasFullscreen = isFullscreen;
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [fitRoutes]);

  return (
    <section
      ref={panelRef}
      className="route-map"
      aria-label={zh ? '路线地图' : 'Route map'}
    >
      <div className="route-map-header">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">
            {zh ? '路线地图' : 'Route map'}
          </h2>
          <p
            className="truncate text-xs text-[var(--color-muted)]"
            title={selectedActivity?.name}
          >
            {selectedActivity
              ? `${selectedActivity.name} · ${(selectedActivity.distance / 1000).toFixed(1)} km`
              : `${routes.length.toLocaleString()} ${zh ? '条轨迹' : 'routes'}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {selectedActivity && onClearSelection && (
            <button className="route-map-action" onClick={onClearSelection}>
              {zh ? '返回总览' : 'Overview'}
            </button>
          )}
          <button
            className="route-map-action"
            disabled={!routes.length}
            onClick={fitRoutes}
            title={zh ? '将所有当前轨迹完整放入视野' : 'Fit all current routes'}
          >
            {zh ? '定位轨迹' : 'Fit routes'}
          </button>
        </div>
      </div>
      {fallbackActivity && (
        <p
          role="status"
          className="px-4 pb-2 text-xs text-[var(--color-muted)]"
        >
          {zh
            ? `此活动没有可用的 GPS 轨迹，现显示之前最近一次有轨迹的活动：${fallbackActivity.name}（${fallbackActivity.start_date_local}）。`
            : `This activity has no usable GPS route. Showing the most recent earlier mapped activity: ${fallbackActivity.name} (${fallbackActivity.start_date_local}).`}
        </p>
      )}
      <div className="route-map-body">
        <div ref={containerRef} className="h-full w-full" />
        {!routes.length && (
          <div className="route-map-empty" role="status">
            {zh
              ? selectedActivity
                ? '这次活动没有 GPS 轨迹'
                : '当前筛选没有 GPS 轨迹'
              : 'No GPS route available'}
          </div>
        )}
      </div>
      <div className="route-map-footer">
        <span role="status" aria-live="polite">
          {status === 'error'
            ? zh
              ? '底图加载失败，请重试'
              : 'Basemap failed to load'
            : status === 'loading'
              ? zh
                ? '正在加载地图…'
                : 'Loading map…'
              : provider === 'amap'
                ? zh
                  ? '底图 · 高德'
                  : 'Basemap · AutoNavi'
                : provider === 'carto'
                  ? zh
                    ? '备用底图 · CARTO'
                    : 'Alternative basemap · CARTO'
                  : zh
                    ? '底图 · Mapbox'
                    : 'Basemap · Mapbox'}
        </span>
        {(status === 'error' || (provider !== 'mapbox' && !!MAPBOX_TOKEN)) && (
          <button
            className="route-map-action"
            onClick={() => {
              setProvider(MAPBOX_TOKEN ? 'mapbox' : 'amap');
              setRetry((value) => value + 1);
            }}
          >
            {provider !== 'mapbox' && MAPBOX_TOKEN
              ? zh
                ? '重试 Mapbox'
                : 'Retry Mapbox'
              : zh
                ? '重试'
                : 'Retry'}
          </button>
        )}
      </div>
    </section>
  );
}
