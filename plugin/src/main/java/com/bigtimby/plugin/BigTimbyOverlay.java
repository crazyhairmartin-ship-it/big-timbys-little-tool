package com.bigtimby.plugin;

import net.runelite.client.ui.overlay.OverlayPanel;
import net.runelite.client.ui.overlay.OverlayPosition;
import net.runelite.client.ui.overlay.components.LineComponent;
import net.runelite.client.ui.overlay.components.TitleComponent;

import javax.inject.Inject;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.text.NumberFormat;
import java.util.Locale;

/**
 * Draggable panel that shows Big Timby's per-item recommendation for the
 * currently-open GE Set-up-offer widget. The prices + fill probabilities
 * come from the backend at /api/recommend?id=<itemId>; the overlay is a
 * pure renderer, doing zero math itself.
 */
public class BigTimbyOverlay extends OverlayPanel
{
    private static final Color BRAND    = new Color(0xF5C518);
    private static final Color GREEN    = new Color(0x4ADE80);
    private static final Color AMBER    = new Color(0xF5C518);
    private static final Color RED      = new Color(0xEF4444);
    private static final Color MUTED    = new Color(0x7D86B0);

    private final BigTimbyConfig config;

    private String itemName;
    private PriceService.Recommendation rec;
    private Integer geOfferPrice;
    private boolean visible;

    @Inject
    public BigTimbyOverlay(BigTimbyConfig config)
    {
        this.config = config;
        setPosition(OverlayPosition.TOP_LEFT);
        setPreferredSize(new Dimension(230, 0));
    }

    public void update(String itemName, PriceService.Recommendation rec, Integer geOfferPrice)
    {
        this.itemName = itemName;
        this.rec = rec;
        this.geOfferPrice = geOfferPrice;
        this.visible = itemName != null;
    }

    public void hide()
    {
        this.visible = false;
        this.itemName = null;
        this.rec = null;
        this.geOfferPrice = null;
    }

    @Override
    public Dimension render(Graphics2D graphics)
    {
        if (!visible || !config.showGeOverlay()) return null;

        panelComponent.getChildren().clear();
        panelComponent.getChildren().add(TitleComponent.builder()
            .text("Big Timby")
            .color(BRAND)
            .build());

        if (itemName != null)
        {
            panelComponent.getChildren().add(LineComponent.builder()
                .left("Item").right(itemName).build());
        }
        if (rec == null)
        {
            panelComponent.getChildren().add(LineComponent.builder()
                .left("Loading…").leftColor(MUTED).build());
            return super.render(graphics);
        }

        if (rec.getMarketLow() != null && rec.getMarketHigh() != null)
        {
            panelComponent.getChildren().add(LineComponent.builder()
                .left("Market")
                .right(fmt(rec.getMarketLow()) + " / " + fmt(rec.getMarketHigh()))
                .rightColor(MUTED)
                .build());
        }

        if (rec.getBuy() != null && rec.getBuy().getPrice() != null)
        {
            panelComponent.getChildren().add(LineComponent.builder()
                .left("Buy at")
                .right(fmt(rec.getBuy().getPrice()))
                .rightColor(GREEN)
                .build());
            addFillProbLine("  fill", rec.getBuy().getFillProbability());
        }
        if (rec.getSell() != null && rec.getSell().getPrice() != null)
        {
            panelComponent.getChildren().add(LineComponent.builder()
                .left("Sell at")
                .right(fmt(rec.getSell().getPrice()))
                .rightColor(GREEN)
                .build());
            addFillProbLine("  fill", rec.getSell().getFillProbability());
        }
        if (geOfferPrice != null && geOfferPrice > 0)
        {
            panelComponent.getChildren().add(LineComponent.builder()
                .left("You typed").right(fmt(geOfferPrice))
                .rightColor(MUTED).build());
        }
        return super.render(graphics);
    }

    private void addFillProbLine(String label, Double fp)
    {
        if (fp == null) return;
        int pct = (int) Math.round(fp * 100);
        Color c = fp >= 0.70 ? GREEN : fp >= 0.45 ? AMBER : RED;
        panelComponent.getChildren().add(LineComponent.builder()
            .left(label).right(pct + "%")
            .leftColor(MUTED).rightColor(c).build());
    }

    private static String fmt(int gp)
    {
        return NumberFormat.getIntegerInstance(Locale.US).format(gp) + " gp";
    }
}
