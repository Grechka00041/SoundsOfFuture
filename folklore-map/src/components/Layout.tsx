import { useState, useCallback, useEffect, useRef } from 'react';
import styles from './Layout.module.css';
import * as React from "react";

interface LayoutProps {
    /** карта */
    children: React.ReactNode;
    /** правая панель: список треков, семплы, DAW */
    sidebar: React.ReactNode;
}

export const Layout = ({ children, sidebar }: LayoutProps) => {
    const [leftWidth, setLeftWidth] = useState(70);
    const isDragging = useRef(false);

    const handleMouseDown = useCallback(() => {
        isDragging.current = true;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, []);

    const handleMouseUp = useCallback(() => {
        isDragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }, []);
    const handleMouseMove = useCallback((e: MouseEvent) => {
        if (!isDragging.current) return;
        const newWidth = (e.clientX / window.innerWidth) * 100;
        setLeftWidth(Math.min(80, Math.max(30, newWidth)));
    }, []);

    useEffect(() => {
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [handleMouseMove, handleMouseUp]);

    return (
        <div className={styles.root}>

            <header className={styles.header}>
                <h1 className={styles.title}>Звуки прошлого: интерактивная платформа цифровизации этнокультурного наследия</h1>
            </header>

            <main className={styles.main}>
                <div
                    style={{ width: `${leftWidth}%` }}
                    className={styles.leftPanel}
                >
                    <div className={styles.mapWrapper}>
                        {children}
                    </div>
                </div>

                <div
                    onMouseDown={handleMouseDown}
                    className={styles.handle}
                >
                    <div className={styles.handleKnob} />
                </div>


                <div className={styles.rightPanel}>{sidebar}</div>

            </main>

            <footer className={styles.footer}>
                <span>© 2026 Sounds of Future Project</span>
                <span>Sounds of Future | TIME MACHINE</span>
            </footer>
        </div>
    );
};