package de.privatecheats;

import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;

/**
 * Cheats, die nur der Server umsetzen kann (Leben, Schaden, Effekte, Items, Gamemode).
 * Sie werden als normale Befehle geschickt und funktionieren nur, wenn der Spieler auf dem Server OP ist.
 */
public final class ServerCommands {
	private ServerCommands() {
	}

	public static void send(String... commands) {
		Minecraft client = Minecraft.getInstance();
		LocalPlayer player = client.player;

		if (player == null) {
			return;
		}

		for (String command : commands) {
			player.connection.sendCommand(command);
		}
	}

	public static void gamemode(String mode) {
		send("gamemode " + mode);
	}

	/** Unsterblich: Schaden-Immunität, Dauer-Regeneration, nie Hunger, feuerfest. */
	public static void godOn() {
		send(
				"effect give @s minecraft:resistance infinite 255 true",
				"effect give @s minecraft:regeneration infinite 255 true",
				"effect give @s minecraft:saturation infinite 255 true",
				"effect give @s minecraft:fire_resistance infinite 0 true",
				"effect give @s minecraft:water_breathing infinite 0 true"
		);
	}

	public static void godOff() {
		send(
				"effect clear @s minecraft:resistance",
				"effect clear @s minecraft:regeneration",
				"effect clear @s minecraft:saturation",
				"effect clear @s minecraft:fire_resistance",
				"effect clear @s minecraft:water_breathing"
		);
	}

	/** One-Hit: Angriffsschaden auf 1000 setzen. */
	public static void oneHitOn() {
		send("attribute @s minecraft:attack_damage base set 1000");
	}

	public static void oneHitOff() {
		send("attribute @s minecraft:attack_damage base set 1");
	}

	/** 1000 Herzen statt 10. */
	public static void megaHealthOn() {
		send("attribute @s minecraft:max_health base set 2000", "effect give @s minecraft:instant_health 1 30 true");
	}

	public static void megaHealthOff() {
		send("attribute @s minecraft:max_health base set 20");
	}

	public static void heal() {
		send("effect give @s minecraft:instant_health 1 30 true", "effect give @s minecraft:saturation 1 30 true");
	}

	public static void effect(String effect, int amplifier) {
		send("effect give @s minecraft:" + effect + " infinite " + amplifier + " true");
	}

	public static void clearEffect(String effect) {
		send("effect clear @s minecraft:" + effect);
	}

	public static void clearAllEffects() {
		send("effect clear @s");
	}

	public static void netheriteKit() {
		send(
				"give @s minecraft:netherite_helmet[enchantments={\"minecraft:protection\":4,\"minecraft:unbreaking\":3}]",
				"give @s minecraft:netherite_chestplate[enchantments={\"minecraft:protection\":4,\"minecraft:unbreaking\":3}]",
				"give @s minecraft:netherite_leggings[enchantments={\"minecraft:protection\":4,\"minecraft:unbreaking\":3}]",
				"give @s minecraft:netherite_boots[enchantments={\"minecraft:protection\":4,\"minecraft:unbreaking\":3,\"minecraft:feather_falling\":4}]",
				"give @s minecraft:netherite_sword[enchantments={\"minecraft:sharpness\":5,\"minecraft:unbreaking\":3,\"minecraft:fire_aspect\":2}]",
				"give @s minecraft:netherite_pickaxe[enchantments={\"minecraft:efficiency\":5,\"minecraft:unbreaking\":3,\"minecraft:fortune\":3}]",
				"give @s minecraft:bow[enchantments={\"minecraft:power\":5,\"minecraft:infinity\":1}]",
				"give @s minecraft:arrow 1",
				"give @s minecraft:golden_apple 64",
				"give @s minecraft:ender_pearl 16"
		);
	}

	public static void diamonds() {
		send("give @s minecraft:diamond 64", "give @s minecraft:netherite_ingot 64", "give @s minecraft:emerald 64");
	}

	public static void day() {
		send("time set day", "weather clear");
	}

	public static void night() {
		send("time set night");
	}
}
