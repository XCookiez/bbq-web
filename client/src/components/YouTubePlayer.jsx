import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

let apiPromise;

function loadApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(script);
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    });
  }

  return apiPromise;
}

const YouTubePlayer = forwardRef(function YouTubePlayer({
  videoId,
  isPlaying,
  onEnded,
  onProgress,
  onPlaybackBlocked,
  onPlaybackStarted,
  resumeToken,
  visible = false,
  playbackCheckDelayMs = 1200,
  volume = 1
}, ref) {
  const elementRef = useRef(null);
  const playerRef = useRef(null);
  const onEndedRef = useRef(onEnded);
  const onProgressRef = useRef(onProgress);
  const onPlaybackBlockedRef = useRef(onPlaybackBlocked);
  const onPlaybackStartedRef = useRef(onPlaybackStarted);
  const progressTimerRef = useRef(null);
  const playbackCheckTimerRef = useRef(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onPlaybackBlockedRef.current = onPlaybackBlocked;
  }, [onPlaybackBlocked]);

  useEffect(() => {
    onPlaybackStartedRef.current = onPlaybackStarted;
  }, [onPlaybackStarted]);

  useImperativeHandle(ref, () => ({
    play() {
      if (!playerRef.current) {
        return false;
      }

      playerRef.current.playVideo();
      verifyPlaybackStarted();
      return true;
    },
    pause() {
      if (!playerRef.current) {
        return false;
      }

      playerRef.current.pauseVideo();
      return true;
    },
    setVolume(volume) {
      if (!playerRef.current) {
        return;
      }

      playerRef.current.setVolume(volume * 100);
    },
    getVolume() {
      if (!playerRef.current) {
        return 100;
      }

      return playerRef.current.getVolume() / 100;
    }
  }), [playbackCheckDelayMs]);

  function verifyPlaybackStarted() {
    window.clearTimeout(playbackCheckTimerRef.current);
    playbackCheckTimerRef.current = window.setTimeout(() => {
      const playerState = playerRef.current?.getPlayerState?.();

      if (playerState === window.YT?.PlayerState?.PLAYING) {
        onPlaybackStartedRef.current?.();
        return;
      }

      if (isPlaying) {
        onPlaybackBlockedRef.current?.();
      }
    }, playbackCheckDelayMs);
  }

  useEffect(() => {
    let isCancelled = false;
    setIsPlayerReady(false);

    loadApi().then((YT) => {
      if (isCancelled || !elementRef.current) {
        return;
      }

      playerRef.current?.destroy();
      playerRef.current = new YT.Player(elementRef.current, {
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: (event) => {
            setIsPlayerReady(true);
            onProgressRef.current?.(0);
            if (isPlaying) {
              event.target.playVideo();
              verifyPlaybackStarted();
            } else {
              event.target.pauseVideo();
            }
          },
          onStateChange: (event) => {
            if (event.data === window.YT.PlayerState.PLAYING) {
              onPlaybackStartedRef.current?.();
            }

            if (event.data === window.YT.PlayerState.ENDED) {
              onEndedRef.current?.();
            }
          }
        }
      });
    });

    return () => {
      isCancelled = true;
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
      window.clearTimeout(playbackCheckTimerRef.current);
      playbackCheckTimerRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  useEffect(() => {
    if (!playerRef.current) {
      return;
    }

    if (isPlaying) {
      playerRef.current.playVideo();
      verifyPlaybackStarted();
      return;
    }

    playerRef.current.pauseVideo();
  }, [isPlaying]);

  useEffect(() => {
    if (playerRef.current && isPlayerReady) {
      playerRef.current.setVolume(volume * 100);
    }
  }, [volume, isPlayerReady]);

  useEffect(() => {
    window.clearInterval(progressTimerRef.current);
    progressTimerRef.current = null;

    if (!isPlaying || !playerRef.current || !onProgressRef.current || !isPlayerReady) {
      return undefined;
    }

    progressTimerRef.current = window.setInterval(() => {
      const currentTime = playerRef.current?.getCurrentTime?.();

      if (typeof currentTime === "number" && Number.isFinite(currentTime)) {
        onProgressRef.current?.(currentTime * 1000);
      }
    }, 500);

    return () => {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    };
  }, [isPlaying, videoId, isPlayerReady]);

  return <div className={visible ? "youtube-player youtube-player-visible" : "youtube-player"} ref={elementRef} />;
});

export default YouTubePlayer;
