package com.bigtimby.plugin;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import lombok.Value;
import lombok.extern.slf4j.Slf4j;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

import javax.inject.Inject;
import javax.inject.Singleton;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.function.Consumer;

/**
 * Fetches Big Timby's per-item recommendation blob from the site's
 * `/api/recommend?id=<itemId>` serverless endpoint and caches it 60s per id.
 * Fetches happen on the shared ScheduledExecutorService so the game thread
 * is never blocked. Callers pass a Consumer that receives the recommendation
 * (or null on failure) — no polling, no futures.
 *
 * Endpoint: {@link #BACKEND_BASE}/api/recommend?id=ID
 * User-Agent identifies this plugin so backend logs can distinguish it from
 * browser traffic.
 */
@Slf4j
@Singleton
public class PriceService
{
    static final String BACKEND_BASE = "https://big-timbys-little-tool.vercel.app";
    private static final String USER_AGENT = "big-timby-plugin/0.1 (personal; https://big-timbys-little-tool.vercel.app)";
    private static final long CACHE_TTL_MS = 60_000;

    @Value
    public static class SideRecommendation
    {
        Integer price;
        Double fillProbability;
    }

    @Value
    public static class Recommendation
    {
        Integer marketHigh;
        Integer marketLow;
        Long marketHighTime;
        Long marketLowTime;
        Integer spread;
        Double spreadPct;
        SideRecommendation buy;
        SideRecommendation sell;
        Instant fetchedAt;
    }

    private final OkHttpClient http;
    private final ScheduledExecutorService executor;
    private final ConcurrentHashMap<Integer, Recommendation> cache = new ConcurrentHashMap<>();

    @Inject
    public PriceService(OkHttpClient http, ScheduledExecutorService executor)
    {
        this.http = http;
        this.executor = executor;
    }

    /**
     * Returns a cached recommendation synchronously if fresh; otherwise
     * triggers a background fetch and calls the callback when done (on the
     * executor thread — hop back to the game thread yourself if you need UI).
     * Returns null if nothing cached — caller should render "loading…".
     */
    public Recommendation get(int itemId, Consumer<Recommendation> onFresh)
    {
        Recommendation cached = cache.get(itemId);
        long age = cached == null ? Long.MAX_VALUE
            : System.currentTimeMillis() - cached.getFetchedAt().toEpochMilli();
        if (cached == null || age > CACHE_TTL_MS)
        {
            executor.execute(() -> fetch(itemId, onFresh));
        }
        return cached;
    }

    private void fetch(int itemId, Consumer<Recommendation> onFresh)
    {
        String url = BACKEND_BASE + "/api/recommend?id=" + itemId;
        Request req = new Request.Builder()
            .url(url)
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json")
            .build();
        try (Response res = http.newCall(req).execute())
        {
            if (!res.isSuccessful() || res.body() == null)
            {
                log.debug("recommend fetch id={} status={}", itemId, res.code());
                return;
            }
            String body = res.body().string();
            JsonObject root = JsonParser.parseString(body).getAsJsonObject();
            JsonObject market = root.has("market") && !root.get("market").isJsonNull()
                ? root.getAsJsonObject("market") : null;
            Recommendation r = new Recommendation(
                market != null ? jsonInt(market, "high") : null,
                market != null ? jsonInt(market, "low") : null,
                market != null ? jsonLong(market, "highTime") : null,
                market != null ? jsonLong(market, "lowTime") : null,
                jsonInt(root, "spread"),
                jsonDouble(root, "spreadPct"),
                parseSide(root, "buy"),
                parseSide(root, "sell"),
                Instant.now()
            );
            cache.put(itemId, r);
            if (onFresh != null) onFresh.accept(r);
        }
        catch (Exception e)
        {
            log.debug("recommend fetch failed id={}: {}", itemId, e.getMessage());
        }
    }

    private static SideRecommendation parseSide(JsonObject root, String key)
    {
        if (!root.has(key) || root.get(key).isJsonNull()) return null;
        JsonObject o = root.getAsJsonObject(key);
        return new SideRecommendation(jsonInt(o, "price"), jsonDouble(o, "fillProbability"));
    }

    private static Integer jsonInt(JsonObject o, String key)
    {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsInt() : null;
    }

    private static Long jsonLong(JsonObject o, String key)
    {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsLong() : null;
    }

    private static Double jsonDouble(JsonObject o, String key)
    {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsDouble() : null;
    }
}
