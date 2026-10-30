package de.privatecheats;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Block;

import java.util.HashSet;
import java.util.Set;

/**
 * Globaler Zustand der Client-Cheats. Wird von den Mixins (hot path!) gelesen, deshalb nur
 * einfache statische Felder.
 */
public final class Cheats {
	public static volatile boolean xray = false;
	public static volatile boolean fullbright = false;
	public static volatile boolean fly = false;
	public static volatile boolean esp = false;
	public static volatile boolean speed = false;
	public static volatile boolean autoSprint = false;

	private static volatile Set<Block> xrayBlocks = new HashSet<>();

	private Cheats() {
	}

	public static boolean isXrayBlock(Block block) {
		return xrayBlocks.contains(block);
	}

	/** Baut die Block-Liste aus der Config neu auf. */
	public static void rebuildXrayBlocks(Config config) {
		Set<Block> set = new HashSet<>();

		for (String id : config.xrayBlocks) {
			Identifier identifier = Identifier.tryParse(id);

			if (identifier == null) {
				PrivateCheatsClient.LOGGER.warn("Ungueltige Block-ID in der Config: {}", id);
				continue;
			}

			BuiltInRegistries.BLOCK.getOptional(identifier).ifPresentOrElse(set::add,
					() -> PrivateCheatsClient.LOGGER.warn("Unbekannter Block in der Config: {}", id));
		}

		if (config.xrayAllOres) {
			for (Block block : BuiltInRegistries.BLOCK) {
				Identifier key = BuiltInRegistries.BLOCK.getKey(block);

				if (key != null && (key.getPath().endsWith("_ore") || key.getPath().equals("ancient_debris"))) {
					set.add(block);
				}
			}
		}

		xrayBlocks = set;
	}
}
