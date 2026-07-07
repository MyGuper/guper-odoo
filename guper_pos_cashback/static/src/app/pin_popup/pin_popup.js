/** @odoo-module **/
import { Component, useState, onWillStart, onWillUnmount } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";

const MAX_ATTEMPTS = 3;

// Resolvido via makeAwaitable (ver cashback_button): getPayload define o
// resultado (true = PIN validado) e close() fecha o dialog.
export class GuperPinPopup extends Component {
    static template = "guper_pos_cashback.PinPopup";
    static components = { Dialog };
    static props = {
        orderUuid: String,
        call: Function, // (path, params) => Promise
        getPayload: Function,
        close: Function,
    };

    setup() {
        this.notification = useService("notification");
        this.state = useState({
            pin: "",
            attempts: 0,
            sentTo: "",
            channel: "",
            remaining: 300, // 5 minutos
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
            this.notification.add(_t("Falha ao enviar o PIN."), { type: "danger" });
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
        if (!iso) return 0;
        const diff = (new Date(iso).getTime() - Date.now()) / 1000;
        return Math.max(0, Math.round(diff));
    }

    get expired() {
        return this.state.remaining <= 0;
    }

    async onResend() {
        this.state.attempts = 0;
        await this._generate();
    }

    async onConfirm() {
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
                this.props.getPayload(true);
                this.props.close();
                return;
            }
            this.state.attempts += 1;
            this.state.pin = "";
            this.notification.add(
                this.state.attempts >= MAX_ATTEMPTS
                    ? _t("Muitas tentativas. Reenvie o PIN.")
                    : _t("PIN invalido."),
                { type: "warning" }
            );
        } finally {
            this.state.busy = false;
        }
    }

    onCancel() {
        this.props.getPayload(false);
        this.props.close();
    }
}
