/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

// Resolvido via makeAwaitable: getPayload = valor em centavos (ou null se cancela).
export class GuperAmountPopup extends Component {
    static template = "guper_pos_cashback.AmountPopup";
    static components = { Dialog };
    static props = {
        balanceCents: Number,
        redeemableCents: Number,
        getPayload: Function,
        close: Function,
    };

    setup() {
        this.state = useState({
            // valor em moeda; default = resgatavel neste pedido
            amount: (this.props.redeemableCents / 100).toFixed(2),
        });
    }

    get balanceLabel() {
        return (this.props.balanceCents / 100).toFixed(2);
    }

    get redeemableLabel() {
        return (this.props.redeemableCents / 100).toFixed(2);
    }

    get maxAmount() {
        return this.props.redeemableCents / 100;
    }

    get amountCents() {
        const v = Math.round(parseFloat(this.state.amount) * 100);
        return Number.isFinite(v) ? v : 0;
    }

    get valid() {
        const c = this.amountCents;
        return c > 0 && c <= this.props.redeemableCents;
    }

    onConfirm() {
        if (!this.valid) {
            return;
        }
        this.props.getPayload(this.amountCents);
        this.props.close();
    }

    onCancel() {
        this.props.getPayload(null);
        this.props.close();
    }
}
