/** @odoo-module **/
import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { usePos } from "@point_of_sale/app/hooks/pos_hook";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { makeAwaitable } from "@point_of_sale/app/utils/make_awaitable_dialog";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";

export class GuperCashbackButton extends Component {
    static template = "guper_pos_cashback.CashbackButton";

    setup() {
        this.pos = usePos();
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.orm = useService("orm"); // usado para chamar os controllers via rpc-like
    }

    async onClick() {
        const order = this.pos.get_order();
        const partner = order.get_partner();
        if (!partner) {
            this.notification.add(_t("Selecione o cliente antes do cashback."), {
                type: "warning",
            });
            return;
        }

        // 1) Cotacao: saldo + maximo resgatavel (server-side reward-by-order).
        const items = this._buildItems(order);
        let quote;
        try {
            quote = await this._call("/guper/redeem/start", {
                order_uuid: order.uuid,
                config_id: this.pos.config.id,
                partner_id: partner.id,
                items,
            });
        } catch (e) {
            this.notification.add(_t("Falha ao consultar cashback Guper."), {
                type: "danger",
            });
            return;
        }

        const redeemable = quote.redeemable_total || 0;
        if (redeemable <= 0) {
            this.notification.add(_t("Sem saldo resgatavel neste pedido."), {
                type: "info",
            });
            return;
        }

        // 2) Cliente escolhe o valor a resgatar (0..redeemable), em centavos.
        const amount = await this._askAmount(redeemable, quote.balance_available);
        if (!amount) {
            return;
        }

        // 3) PIN sempre exigido no resgate: gera + valida via popup (5 min).
        const ok = await makeAwaitable(this.dialog, GuperPinPopup, {
            orderUuid: order.uuid,
            call: (path, params) => this._call(path, params),
        });
        if (!ok) {
            this.notification.add(_t("Resgate cancelado (PIN nao validado)."), {
                type: "warning",
            });
            return;
        }

        // 4) Linha de desconto = -valor. O confirmOrder ocorre no fechamento.
        const product = this.pos.db.get_product_by_id(
            this.pos.config.guper_cashback_product_id[0]
        );
        order.add_product(product, { price: -(amount / 100), quantity: 1 });
        order.guper_redeem_amount = amount; // centavos; consumido no pagamento
        this.notification.add(_t("Cashback aplicado."), { type: "success" });
    }

    _buildItems(order) {
        const cashbackId = (this.pos.config.guper_cashback_product_id || [])[0];
        return order
            .get_orderlines()
            .filter((l) => l.product.id !== cashbackId && l.quantity > 0)
            .map((l) => ({
                id: l.product.default_code || String(l.product.id),
                name: l.product.display_name,
                quantity: Math.round(l.quantity),
                price: Math.round(l.price * 100),
                productId: String(l.product.id),
            }));
    }

    async _askAmount(redeemable, balance) {
        // TODO(guper): usar o NumberPopup/Dialog do build 18 instalado.
        // Placeholder simples: resgata o maximo. Trocar por input de valor.
        return redeemable;
    }

    async _call(path, params) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }),
        });
        const data = await res.json();
        if (data.error) {
            throw new Error(data.error.data?.message || data.error.message);
        }
        return data.result;
    }
}

// TODO(guper): confirmar o nome da categoria de botoes de controle no build 18
// instalado (pode variar entre point-releases). Alternativas comuns:
//   "pos_screen_control_buttons"  /  ProductScreen control buttons registry.
registry.category("pos_screen_control_buttons").add("GuperCashbackButton", {
    component: GuperCashbackButton,
});
