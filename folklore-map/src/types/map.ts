export interface Track {
    id: number;
    title: string;
    artist?: string;
    duration: number;
    region: string;
    isInstrument: boolean;
    globalRegion: string;
    link: string;
    /** сколько семплов (стемов) у трека — для подписи в списке */
    samplesCount?: number;
}

/** Семпл (стем) трека: одна дорожка в мини-DAW */
export interface TrackSample {
    id: number;
    name: string;
    url: string;
    order: number;
}

export interface RegionFeatureProperties {
    name: string;
    name_en?: string;
    fo?: string;
    code?: string;
    capital?: string;
}

export interface RegionFeature extends GeoJSON.Feature<GeoJSON.Geometry, RegionFeatureProperties> {
    properties: RegionFeatureProperties;
}

export interface RegionGeoJSON extends GeoJSON.FeatureCollection<GeoJSON.Geometry, RegionFeatureProperties> {
    features: RegionFeature[];
}