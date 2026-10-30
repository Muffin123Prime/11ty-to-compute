package de.privatecheats;

import net.minecraft.ChatFormatting;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Das Mod-Menü (Standard-Taste L). Links: Client-Cheats als Schalter. Rechts: Server-Cheats,
 * die als Befehle geschickt werden und OP-Rechte brauchen.
 */
public class CheatScreen extends Screen {
	private static final int PANEL_WIDTH = 470;
	private static final int PANEL_HEIGHT = 262;
	private static final int BUTTON_HEIGHT = 20;
	private static final int ROW = 24;

	private static final int COLOR_PANEL = 0xE0101318;
	private static final int COLOR_BORDER = 0xFF2FD3FF;
	private static final int COLOR_HEADER = 0xFF161B24;
	private static final int COLOR_SECTION = 0xFF2FD3FF;
	private static final int COLOR_TEXT = 0xFFE6EDF3;
	private static final int COLOR_HINT = 0xFF8B949E;

	private final List<Runnable> refreshers = new ArrayList<>();
	private int panelX;
	private int panelY;

	public CheatScreen() {
		super(Component.literal("PrivateCheats"));
	}

	@Override
	protected void init() {
		refreshers.clear();
		panelX = (this.width - PANEL_WIDTH) / 2;
		panelY = (this.height - PANEL_HEIGHT) / 2;

		int leftX = panelX + 12;
		int leftWidth = 150;
		int y = panelY + 46;

		// ---- Client-Cheats (immer möglich) ----
		toggle(leftX, y, leftWidth, "X-Ray", () -> Cheats.xray, () -> PrivateCheatsClient.toggleXray());
		y += ROW;
		toggle(leftX, y, leftWidth, "Fullbright", () -> Cheats.fullbright, () -> Cheats.fullbright = !Cheats.fullbright);
		y += ROW;
		toggle(leftX, y, leftWidth, "Fly", () -> Cheats.fly, () -> Cheats.fly = !Cheats.fly);
		y += ROW;
		toggle(leftX, y, leftWidth, "ESP (Wallhack)", () -> Cheats.esp, () -> Cheats.esp = !Cheats.esp);
		y += ROW;
		toggle(leftX, y, leftWidth, "Speed", () -> Cheats.speed, () -> Cheats.speed = !Cheats.speed);
		y += ROW;
		toggle(leftX, y, leftWidth, "AutoSprint", () -> Cheats.autoSprint, () -> Cheats.autoSprint = !Cheats.autoSprint);
		y += ROW;
		action(leftX, y, leftWidth, "Alles AUS", ChatFormatting.RED, () -> {
			if (Cheats.xray) PrivateCheatsClient.toggleXray();
			Cheats.fullbright = false;
			Cheats.fly = false;
			Cheats.esp = false;
			Cheats.speed = false;
			Cheats.autoSprint = false;
		});

		// ---- Server-Cheats (OP nötig) ----
		int rightX = panelX + 182;
		int half = 134;
		int gap = 8;
		y = panelY + 46;

		action(rightX, y, half, "Kreativ", ChatFormatting.GREEN, () -> ServerCommands.gamemode("creative"));
		action(rightX + half + gap, y, half, "Überleben", ChatFormatting.YELLOW, () -> ServerCommands.gamemode("survival"));
		y += ROW;
		action(rightX, y, half, "Zuschauer", ChatFormatting.AQUA, () -> ServerCommands.gamemode("spectator"));
		action(rightX + half + gap, y, half, "Heilen + Sättigen", ChatFormatting.LIGHT_PURPLE, ServerCommands::heal);
		y += ROW;
		onOff(rightX, y, half, gap, "Unsterblich (God)", ServerCommands::godOn, ServerCommands::godOff);
		y += ROW;
		onOff(rightX, y, half, gap, "One-Hit (1000 Schaden)", ServerCommands::oneHitOn, ServerCommands::oneHitOff);
		y += ROW;
		onOff(rightX, y, half, gap, "1000 Herzen", ServerCommands::megaHealthOn, ServerCommands::megaHealthOff);
		y += ROW;
		onOff(rightX, y, half, gap, "Speed-Effekt V", () -> ServerCommands.effect("speed", 4), () -> ServerCommands.clearEffect("speed"));
		y += ROW;
		onOff(rightX, y, half, gap, "Eile (Insta-Abbau)", () -> ServerCommands.effect("haste", 10), () -> ServerCommands.clearEffect("haste"));
		y += ROW;
		onOff(rightX, y, half, gap, "Unsichtbar", () -> ServerCommands.effect("invisibility", 0), () -> ServerCommands.clearEffect("invisibility"));
		y += ROW;
		action(rightX, y, half, "Netherite-Kit", ChatFormatting.GOLD, ServerCommands::netheriteKit);
		action(rightX + half + gap, y, half, "64 Diamanten & Co.", ChatFormatting.AQUA, ServerCommands::diamonds);

		// ---- unten ----
		int bottomY = panelY + PANEL_HEIGHT - 30;
		action(leftX, bottomY, 70, "Tag", ChatFormatting.YELLOW, ServerCommands::day);
		action(leftX + 78, bottomY, 70, "Nacht", ChatFormatting.BLUE, ServerCommands::night);
		action(rightX, bottomY, half, "Alle Effekte weg", ChatFormatting.RED, ServerCommands::clearAllEffects);
		action(rightX + half + gap, bottomY, half, "Schließen", ChatFormatting.WHITE, this::onClose);
	}

	private void toggle(int x, int y, int width, String name, BooleanSupplier state, Runnable onPress) {
		Button button = this.addRenderableWidget(Button.builder(toggleLabel(name, state.getAsBoolean()), b -> {
			onPress.run();
			refreshAll();
		}).pos(x, y).size(width, BUTTON_HEIGHT).build());
		refreshers.add(() -> button.setMessage(toggleLabel(name, state.getAsBoolean())));
	}

	private void onOff(int x, int y, int half, int gap, String name, Runnable on, Runnable off) {
		action(x, y, half, name + " AN", ChatFormatting.GREEN, on);
		action(x + half + gap, y, half, name + " AUS", ChatFormatting.RED, off);
	}

	private void action(int x, int y, int width, String name, ChatFormatting color, Runnable onPress) {
		this.addRenderableWidget(Button.builder(Component.literal(name).withStyle(color), b -> onPress.run())
				.pos(x, y).size(width, BUTTON_HEIGHT).build());
	}

	private static Component toggleLabel(String name, boolean on) {
		return Component.literal(name + ": ").withStyle(ChatFormatting.WHITE)
				.append(Component.literal(on ? "AN" : "AUS").withStyle(on ? ChatFormatting.GREEN : ChatFormatting.RED));
	}

	private void refreshAll() {
		for (Runnable refresher : refreshers) {
			refresher.run();
		}
	}

	@Override
	public void extractRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float delta) {
		this.extractBackground(graphics, mouseX, mouseY, delta);

		int x2 = panelX + PANEL_WIDTH;
		int y2 = panelY + PANEL_HEIGHT;

		// Rahmen + Panel
		graphics.fill(panelX - 1, panelY - 1, x2 + 1, y2 + 1, COLOR_BORDER);
		graphics.fill(panelX, panelY, x2, y2, COLOR_PANEL);
		// Kopfzeile
		graphics.fill(panelX, panelY, x2, panelY + 26, COLOR_HEADER);
		graphics.fill(panelX, panelY + 26, x2, panelY + 27, COLOR_BORDER);

		graphics.text(this.font, "PrivateCheats", panelX + 12, panelY + 9, COLOR_SECTION);
		String hint = "Menü-Taste: " + PrivateCheatsClient.menuKeyName() + "  (änderbar unter Steuerung)";
		graphics.text(this.font, hint, x2 - 12 - this.font.width(hint), panelY + 9, COLOR_HINT);

		graphics.text(this.font, "Client-Cheats", panelX + 12, panelY + 34, COLOR_TEXT);
		graphics.text(this.font, "Server-Cheats (ihr braucht OP auf dem Server)", panelX + 182, panelY + 34, COLOR_TEXT);

		super.extractRenderState(graphics, mouseX, mouseY, delta);
	}

	@Override
	public boolean isPauseScreen() {
		return false;
	}
}
