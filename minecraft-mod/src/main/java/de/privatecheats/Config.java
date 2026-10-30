package de.privatecheats;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Wird als JSON unter config/privatecheats.json gespeichert und kann dort angepasst werden. */
public class Config {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
	private static final Path PATH = FabricLoader.getInstance().getConfigDir().resolve("privatecheats.json");

	/** Blöcke, die bei aktivem X-Ray sichtbar bleiben. */
	public List<String> xrayBlocks = new ArrayList<>(List.of(
			"minecraft:diamond_ore",
			"minecraft:deepslate_diamond_ore",
			"minecraft:emerald_ore",
			"minecraft:deepslate_emerald_ore",
			"minecraft:gold_ore",
			"minecraft:deepslate_gold_ore",
			"minecraft:nether_gold_ore",
			"minecraft:iron_ore",
			"minecraft:deepslate_iron_ore",
			"minecraft:copper_ore",
			"minecraft:deepslate_copper_ore",
			"minecraft:coal_ore",
			"minecraft:deepslate_coal_ore",
			"minecraft:redstone_ore",
			"minecraft:deepslate_redstone_ore",
			"minecraft:lapis_ore",
			"minecraft:deepslate_lapis_ore",
			"minecraft:nether_quartz_ore",
			"minecraft:ancient_debris",
			"minecraft:chest",
			"minecraft:trapped_chest",
			"minecraft:ender_chest",
			"minecraft:barrel",
			"minecraft:spawner",
			"minecraft:trial_spawner",
			"minecraft:vault",
			"minecraft:beacon",
			"minecraft:end_portal_frame",
			"minecraft:lava",
			"minecraft:water"
	));

	/** Zusätzlich automatisch jeden Block, dessen ID auf "_ore" endet (auch aus anderen Mods). */
	public boolean xrayAllOres = true;

	/** Fluggeschwindigkeit. Vanilla-Kreativ ist 0.05. */
	public float flySpeed = 0.1f;

	/** Bei X-Ray automatisch Fullbright einschalten, sonst sieht man nur Schwarz. */
	public boolean xrayEnablesFullbright = true;

	/** ESP nur für Spieler (true) oder für alle Lebewesen (false). */
	public boolean espPlayersOnly = false;

	/** Geschwindigkeits-Multiplikator für den Speed-Cheat am Boden (1.0 = normal). */
	public float speedMultiplier = 1.8f;

	public static Config load() {
		if (Files.exists(PATH)) {
			try {
				Config config = GSON.fromJson(Files.readString(PATH), Config.class);

				if (config != null) {
					return config;
				}
			} catch (IOException | RuntimeException e) {
				PrivateCheatsClient.LOGGER.error("Config konnte nicht gelesen werden, benutze Standardwerte", e);
			}
		}

		Config config = new Config();
		config.save();
		return config;
	}

	public void save() {
		try {
			Files.createDirectories(PATH.getParent());
			Files.writeString(PATH, GSON.toJson(this));
		} catch (IOException e) {
			PrivateCheatsClient.LOGGER.error("Config konnte nicht gespeichert werden", e);
		}
	}
}
