package com.bigtimby.plugin;

import net.runelite.client.config.Config;
import net.runelite.client.config.ConfigGroup;
import net.runelite.client.config.ConfigItem;

@ConfigGroup(BigTimbyConfig.GROUP)
public interface BigTimbyConfig extends Config
{
    String GROUP = "bigtimby";

    @ConfigItem(
        keyName = "showGeOverlay",
        name = "Show GE overlay",
        description = "Render Big Timby's recommendation on the Grand Exchange setup screen."
    )
    default boolean showGeOverlay() { return true; }
}
