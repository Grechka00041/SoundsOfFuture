    import { useEffect, useRef } from 'react';
    import { useMap } from 'react-leaflet';
    import L from 'leaflet';
    import * as turf from '@turf/turf';
    import './Map.css';
    import type { Track } from '../types/map';

    interface TrackMarkersProps {
        tracks: Track[];
        onPlayTrack: (track: Track) => void;
        onAddTrack: (track: Track) => void;
        selectedRegionName: string | null;
        regionGeometry: any;
    }

    const escapeHtml = (text: string): string =>
        text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

    const renderPinIcon = (title: string): L.DivIcon => {
        const pinHtml = `
            <div class="pin-wrapper">
                <div class="permanent-track-label">${escapeHtml(title)}</div>
                <div class="pin-container">
                    <div class="pin-head"></div>
                    <div class="pin-stem"></div>
                    <div class="pin-tip"></div>
                </div>
            </div>
        `;

        return L.divIcon({
            className: 'track-pin',
            html: pinHtml,
            iconSize: [100, 60],
            iconAnchor: [50, 60]
        });
    };

    const createPopupContent = (track: Track): string => {
        const mixerBtn = `<button class="add-to-mixer-btn" data-id="${track.id}" title="Добавить в микшер">+</button>`;
        const playBtn = `<button class="play-track-btn" data-id="${track.id}" title="Слушать">▶</button>`;

        let durationBlock = '';
        if (track.duration) {
            const mins = Math.floor(track.duration / 60);
            const secs = track.duration % 60;
            const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
            durationBlock = `<div class="popup-duration"> ${timeStr}</div>`;
        }

        return `
            <div class="popup-header">
                <div class="popup-title">${escapeHtml(track.title)}</div>
            </div>
            
            ${track.artist ? `<div class="popup-artist">${escapeHtml(track.artist)}</div>` : ''}
            
            <div class="popup-footer">
                ${durationBlock}
                <div class="popup-actions">
                    ${mixerBtn}
                    ${playBtn}
                </div>
            </div>
        `;
    };

    const centerCache = new Map<string, [number, number]>();

    export const TrackMarkers = ({ tracks, selectedRegionName, regionGeometry, onPlayTrack, onAddTrack }: TrackMarkersProps) => {
        const map = useMap();
        const markersRef = useRef<L.LayerGroup | null>(null);
        const clickHandlerRef = useRef<((e: MouseEvent) => void) | null>(null);

        useEffect(() => {
            if (!markersRef.current) {
                markersRef.current = L.layerGroup().addTo(map);
            }
            return () => {
                if (markersRef.current) {
                    map.removeLayer(markersRef.current);
                    markersRef.current = null;
                }
            };
        }, [map]);

        useEffect(() => {
            const handleClick = (e: MouseEvent) => {
                const target = e.target as HTMLElement;


                const mixerBtn = target.closest('.add-to-mixer-btn');
                if (mixerBtn) {
                    e.stopPropagation();
                    const trackId = mixerBtn.getAttribute('data-id');
                    const track = tracks.find(t => t.id === Number(trackId));
                    if (track) {
                        onAddTrack(track);
                        mixerBtn.classList.add('added');
                        mixerBtn.textContent = '✓';
                        setTimeout(() => {
                            mixerBtn.classList.remove('added');
                            mixerBtn.textContent = '+';
                        }, 1000);
                    }
                    return;
                }

                const playBtn = target.closest('.play-track-btn');
                if (playBtn) {
                    e.stopPropagation();
                    const trackId = playBtn.getAttribute('data-id');
                    const track = tracks.find(t => t.id === Number(trackId));
                    if (track) {
                        onPlayTrack(track);
                    }
                    return;
                }
            };

            clickHandlerRef.current = handleClick;
            map.getContainer().addEventListener('click', handleClick);

            return () => {
                if (clickHandlerRef.current) {
                    map.getContainer().removeEventListener('click', clickHandlerRef.current);
                }
            };
        }, [map, tracks, onPlayTrack, onAddTrack]);

        useEffect(() => {
            if (!markersRef.current || !selectedRegionName || !regionGeometry) {
                markersRef.current?.clearLayers();
                return;
            }

            markersRef.current.clearLayers();

            let center: [number, number];
            if (centerCache.has(selectedRegionName)) {
                center = centerCache.get(selectedRegionName)!;
            } else {
                try {
                    const centroid = turf.centroid(regionGeometry);
                    center = [centroid.geometry.coordinates[1], centroid.geometry.coordinates[0]];
                    centerCache.set(selectedRegionName, center);
                } catch (e) {
                    console.error('Ошибка расчета центроида:', e);
                    return;
                }
            }

            const regionTracks = tracks;

            regionTracks.forEach((track, index) => {
                const latOffset = Math.sin(index * 12.9898) * 0.4;
                const lonOffset = Math.cos(index * 78.233) * 0.4;

                const markerPos: [number, number] = [
                    center[0] + latOffset,
                    center[1] + lonOffset
                ];

                const icon = renderPinIcon(track.title);
                const marker = L.marker(markerPos, { icon });

                const popupContent = createPopupContent(track);

                marker.bindPopup(popupContent, {
                    className: 'retro-popup',
                    maxWidth: 320,
                    closeButton: true
                });

                markersRef.current!.addLayer(marker);
            });

        }, [tracks, selectedRegionName, regionGeometry]);

        return null;
    };