/** @odoo-module **/
import { AbstractAwaitablePopup } from "@point_of_sale/app/popup/abstract_awaitable_popup";
import { useState } from "@odoo/owl";

export class GuperAmountPopup extends AbstractAwaitablePopup {
    static template = "guper_pos_cashback.AmountPopup";
    static defaultProps = { balanceCents: 0, redeemableCents: 0 };

    setup() {
        super.setup();
        this.state = useState({
            amount: (this.props.redeemableCents / 100).toFixed(2), // moeda
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

    getPayload() {
        return this.amountCents;
    }

    // Bloqueia o confirm se invalido; senao resolve com o valor em centavos.
    confirm() {
        if (!this.valid) {
            return;
        }
        this.props.resolve({ confirmed: true, payload: this.getPayload() });
        this.props.close();
    }
}
