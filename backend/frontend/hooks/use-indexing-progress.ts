"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/features/auth/auth-context";
import { subscribeToIndexing } from "@/services/sse/indexing-events";
import type { IndexingProgress } from "@/types/api";

export function useIndexingProgress(repositoryId: string, initial?: IndexingProgress) {
  const { token } = useAuth();
  const [progress, setProgress] = useState<IndexingProgress | undefined>(initial);
  const [connected, setConnected] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!token || !repositoryId) return;
    const controller = new AbortController();
    void subscribeToIndexing(repositoryId, token, {
      onProgress: (event) => {
        setProgress(event);
        setDisconnected(false);
        setReconnecting(false);
        setStreamError(null);
      },
      onConnectionChange: (value) => {
        setConnected(value);
        if (value) setReconnecting(false);
      },
      onReconnect: () => {
        setDisconnected(true);
        setReconnecting(true);
      },
      onError: (error) => {
        setDisconnected(true);
        setStreamError(error);
      },
    }, controller.signal);
    return () => controller.abort();
  }, [generation, repositoryId, token]);

  return {
    progress,
    connected,
    disconnected,
    reconnecting,
    streamError,
    retry: () => {
      setStreamError(null);
      setDisconnected(false);
      setGeneration((value) => value + 1);
    },
  };
}
