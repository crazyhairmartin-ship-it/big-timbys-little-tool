package com.bigtimby.plugin;

import com.google.inject.Provides;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.Client;
import net.runelite.api.ItemComposition;
import net.runelite.api.events.VarClientIntChanged;
import net.runelite.api.events.WidgetLoaded;
import net.runelite.api.widgets.Widget;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.game.ItemManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.overlay.OverlayManager;

import javax.inject.Inject;

/**
 * Big Timby's Little Tool — RuneLite plugin (personal / dev-mode).
 *
 * Watches the Grand Exchange "Set up offer" widget. When it opens, reads the
 * item id being traded, fetches live wiki prices via PriceService, and shows
 * a recommendation overlay next to the GE screen.
 *
 * Purely informational. No input generation, no auto-fill, nothing typed into
 * the game on the user's behalf. See project README for the ban-risk analysis.
 */
@Slf4j
@PluginDescriptor(
    name = "Big Timby",
    description = "Live GE margin recommendations from Big Timby's Little Tool",
    tags = {"ge", "grand", "exchange", "flipping", "margin", "timby"}
)
public class BigTimbyPlugin extends Plugin
{
    /*
     * WidgetInfo IDs to verify against your RuneLite version — these are the
     * canonical constants but the wiki/API sometimes renames. Grep the
     * runelite-api WidgetInfo enum in your local runelite clone if any of
     * these fail to compile:
     *   GRAND_EXCHANGE_OFFER_CONTAINER
     *   GRAND_EXCHANGE_OFFER_PRICE
     * Widget group id 465 = GE. The specific "Set up offer" child varies by
     * layout revision, so we key on group opens + var-triggered updates.
     */
    private static final int GE_WIDGET_GROUP_ID = 465;
    private static final int VARCINT_GE_OFFER_ITEM = 1151;  // the currently-open offer's item id
    private static final int VARCINT_GE_OFFER_PRICE = 1153; // the price the user has typed in

    @Inject private Client client;
    @Inject private ClientThread clientThread;
    @Inject private ItemManager itemManager;
    @Inject private OverlayManager overlayManager;
    @Inject private BigTimbyConfig config;
    @Inject private PriceService priceService;
    @Inject private BigTimbyOverlay overlay;

    private int lastItemId = -1;

    @Provides
    BigTimbyConfig provideConfig(ConfigManager cm)
    {
        return cm.getConfig(BigTimbyConfig.class);
    }

    @Override
    protected void startUp()
    {
        overlayManager.add(overlay);
        log.info("Big Timby: enabled");
    }

    @Override
    protected void shutDown()
    {
        overlayManager.remove(overlay);
        overlay.hide();
        lastItemId = -1;
        log.info("Big Timby: disabled");
    }

    @Subscribe
    public void onWidgetLoaded(WidgetLoaded event)
    {
        // Whenever the GE opens, poll the current item id so the overlay
        // shows immediately without waiting for the user to type.
        if (event.getGroupId() == GE_WIDGET_GROUP_ID)
        {
            refreshFromCurrentOffer();
        }
    }

    @Subscribe
    public void onVarClientIntChanged(VarClientIntChanged event)
    {
        // The GE mutates two VarClientInts as the user picks items + types
        // prices. Reacting to these gives us live-updating recommendations
        // as the offer setup panel changes state.
        int idx = event.getIndex();
        if (idx == VARCINT_GE_OFFER_ITEM || idx == VARCINT_GE_OFFER_PRICE)
        {
            refreshFromCurrentOffer();
        }
    }

    /**
     * Reads the currently-open offer state from client vars and updates the
     * overlay. Called both on GE open (widget load) and on var updates while
     * the user is interacting. Cheap — bails out fast when nothing's changed.
     */
    private void refreshFromCurrentOffer()
    {
        int itemId = client.getVarcIntValue(VARCINT_GE_OFFER_ITEM);
        int typedPrice = client.getVarcIntValue(VARCINT_GE_OFFER_PRICE);
        if (itemId <= 0)
        {
            overlay.hide();
            lastItemId = -1;
            return;
        }
        // Only rebuild the item-name lookup + price fetch when the item
        // actually changed. Price-typed changes just re-render.
        boolean itemChanged = itemId != lastItemId;
        lastItemId = itemId;
        String itemName = safeItemName(itemId);
        PriceService.Recommendation cached = priceService.get(itemId, fresh ->
            // The callback fires off-thread; hop back to the game thread
            // before touching UI state.
            clientThread.invokeLater(() -> overlay.update(itemName, fresh,
                typedPrice > 0 ? typedPrice : null))
        );
        overlay.update(itemName, cached, typedPrice > 0 ? typedPrice : null);
        if (itemChanged)
        {
            log.debug("Big Timby: tracking item id {} ({})", itemId, itemName);
        }
    }

    private String safeItemName(int itemId)
    {
        try
        {
            ItemComposition c = itemManager.getItemComposition(itemId);
            return c != null ? c.getName() : "#" + itemId;
        }
        catch (Exception e)
        {
            return "#" + itemId;
        }
    }
}
