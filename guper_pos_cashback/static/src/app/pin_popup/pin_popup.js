/** @odoo-module **/
// Odoo 17: popups estendem AbstractAwaitablePopup e sao abertos pelo servico
// `popup` (this.popup.add(...) -> {confirmed, payload}).
import { AbstractAwaitablePopup } from "@point_of_sale/app/popup/abstract_awaitable_popup";
import { useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";

const MAX_ATTEMPTS = 3;

export class GuperPinPopup extends AbstractAwaitablePopup {
    static template = "guper_pos_cashback.PinPopup";
    static defaultProps = { orderUuid: "", call: null };

    setup() {
        super.setup();
        this.notification = useService("notification");
        this.state = useState({
            pin: "",
            attempts: 0,
            sentTo: "",
            channel: "",
            remaining: 300,
            busy: false,
        });
        this._timer = null;
        onWillStart(() => this._generate());
        onWillUnmount(() => this._timer && clearInterval(this._timer));
    }

    async _generate() {
        this.state.busy = true;
        try {
            const res = await this.props.call("/guper/pin/generate", {
                order_uuid: this.props.orderUuid,
            });
            this.state.sentTo = res.sent_to || "";
            this.state.channel = res.channel || "whatsapp";
            this.state.remaining = this._secondsUntil(res.expires_at) || 300;
            this.state.pin = "";
            this._startCountdown();
        } catch (e) {
            this.notification.add(_t("Fallo al enviar el PIN."), { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }

    _startCountdown() {
        if (this._timer) {
            clearInterval(this._timer);
        }
        this._timer = setInterval(() => {
            if (this.state.remaining > 0) {
                this.state.remaining -= 1;
            } else {
                clearInterval(this._timer);
            }
        }, 1000);
    }

    _secondsUntil(iso) {
        if (!iso) {
            return 0;
        }
        const diff = (new Date(iso).getTime() - Date.now()) / 1000;
        return Math.max(0, Math.round(diff));
    }

    get expired() {
        return this.state.remaining <= 0;
    }

    get remainingLabel() {
        const m = Math.floor(this.state.remaining / 60);
        const s = String(this.state.remaining % 60).padStart(2, "0");
        return `${m}:${s}`;
    }

    async onResend() {
        this.state.attempts = 0;
        await this._generate();
    }

    // Sobrescreve o confirm do AbstractAwaitablePopup: valida o PIN antes de
    // fechar; se invalido, permanece aberto.
    async confirm() {
        if (this.state.busy || this.state.pin.length !== 4) {
            return;
        }
        this.state.busy = true;
        try {
            const res = await this.props.call("/guper/pin/validate", {
                order_uuid: this.props.orderUuid,
                pin: this.state.pin,
            });
            if (res.valid) {
                this.props.resolve({ confirmed: true, payload: true });
                this.props.close();
                return;
            }
            this.state.attempts += 1;
            this.state.pin = "";
            this.notification.add(
                this.state.attempts >= MAX_ATTEMPTS
                    ? _t("Demasiados intentos. Reenvíe el PIN.")
                    : _t("PIN inválido."),
                { type: "warning" }
            );
        } finally {
            this.state.busy = false;
        }
    }
}
