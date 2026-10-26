import {useState} from 'react';
import {Layout} from './components/Layout';
import {RegionMap} from './components/Map';
import {SidePanel} from './components/SidePanel';
import {useRegionTracks} from './hooks/useRegionTracks';
import {useStudio} from './hooks/useStudio';

function App() {
    const [selectedRegionName, setSelectedRegionName] = useState<string | null>(null);
    const {tracks, loading} = useRegionTracks(selectedRegionName);
    const studio = useStudio();

    return (
        <Layout
            sidebar={
                <SidePanel
                    regionName={selectedRegionName}
                    tracks={tracks}
                    loading={loading}
                    studio={studio}
                />
            }
        >
            <RegionMap
                selectedRegionName={selectedRegionName}
                onSelect={setSelectedRegionName}
                tracks={tracks}
                isLoadingTracks={loading}
                onPlayTrack={track => void studio.openTrack(track, {autoplay: true})}
                onAddTrack={track => void studio.addTrack(track)}
            />
        </Layout>
    );
}

export default App;
