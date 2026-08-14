import { App, Modal, ButtonComponent } from "obsidian";

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private confirmLabel: string,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: this.title });
		contentEl.createEl("p", { text: this.message });

		const buttons = contentEl.createDiv({ cls: "marathoner-confirm-buttons" });

		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());

		new ButtonComponent(buttons)
			.setButtonText(this.confirmLabel)
			.setWarning()
			.onClick(async () => {
				this.close();
				await this.onConfirm();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
