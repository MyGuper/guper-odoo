/** @odoo-module **/
// Odoo 17: control button = componente proprio registrado via
// ProductScreen.addControlButton. API de pedido/linha em snake_case.
import { Component } from "@odoo/owl";
import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { useService } from "@web/core/utils/hooks";
import { _t } from "@web/core/l10n/translation";
import { GuperPinPopup } from "@guper_pos_cashback/app/pin_popup/pin_popup";
import { GuperAmountPopup } from "@guper_pos_cashback/app/amount_popup/amount_popup";

export class GuperCashbackButton extends Component {
    static template = "guper_pos_cashback.CashbackButton";

    setup() {
        this.pos = usePos();
        this.popup = useService("popup");
        this.notification = useService("notification");
    }

    // Identificador do pedido usado como chave em todo o fluxo (sessao,
    // confirmOrder, e casamento no backend). Em 17 usamos order.name, que vira
    // o pos_reference no backend.
    _orderRef(order) {
        return order.name || order.uid;
    }

    async onClick() {
        const order = this.pos.get_order();
        const partner = order && order.get_partner();
        if (!partner) {
            this.notification.add(_t("Seleccione el cliente antes del cashback."), {
                type: "warning",
            });
            return;
        }
        const orderRef = this._orderRef(order);

        // 1) Cotacao
        let quote;
        try {
            quote = await this._guperCall("/guper/redeem/start", {
                order_uuid: orderRef,
                config_id: this.pos.config.id,
                partner_id: partner.id,
                items: this._guperItems(order),
            });
        } catch (e) {
            this.notification.add("Guper: " + (e.message || _t("error desconocido")), {
                type: "danger",
            });
            return;
        }

        const redeemable = quote.redeemable_max || 0;
        if (redeemable <= 0) {
            this.notification.add(_t("Sin saldo canjeable en este pedido."), {
                type: "info",
            });
            return;
        }

        // 2) PIN
        const { confirmed: pinOk } = await this.popup.add(GuperPinPopup, {
            orderUuid: orderRef,
            call: (path, params) => this._guperCall(path, params),
        });
        if (!pinOk) {
            this.notification.add(_t("Canje cancelado (PIN no validado)."), {
                type: "warning",
            });
            return;
        }

        // 3) Valor a resgatar
        const { confirmed, payload: amount } = await this.popup.add(GuperAmountPopup, {
            balanceCents: quote.balance_total || 0,
            redeemableCents: redeemable,
        });
        if (!confirmed || !amount) {
            return;
        }

        // 4) Desconto por linha. O % e calculado sobre o total da linha COM
        //    imposto (campo price_subtotal_incl = valor c/ imposto x qtd), para
        //    o total do pedido cair exatamente o valor resgatado. E ADITIVO ao
        //    desconto que a linha ja tiver (pricelist/promo).
        const lines = order.get_orderlines().filter((l) => l.get_quantity() > 0);
        const grossOf = (l) => {
            if (l.price_subtotal_incl != null) {
                return l.price_subtotal_incl;
            }
            if (typeof l.get_price_with_tax === "function") {
                return l.get_price_with_tax();
            }
            return (l.get_unit_price() || 0) * l.get_quantity();
        };
        const addDiscount = (l, pct) => {
            const existing =
                typeof l.get_discount === "function" ? l.get_discount() : l.discount || 0;
            l.set_discount(Math.min(100, existing + pct));
        };

        const rFull = quote.redeemable_full || redeemable;
        const factor = rFull > 0 ? amount / rFull : 0;
        const valueByItem = {};
        (quote.redeemable_items || []).forEach((it) => {
            valueByItem[String(it.id)] = it.value;
        });

        let applied = false;
        for (const l of lines) {
            const p = l.get_product();
            const itemId = p.default_code || String(p.id);
            const value = valueByItem[itemId];
            const gross = grossOf(l);
            if (!value || gross <= 0) {
                continue;
            }
            const pct = (((value * factor) / 100) / gross) * 100;
            console.log("[Guper v2] item", itemId, "base(c/imposto)=", gross, "desc%=", pct);
            addDiscount(l, pct);
            applied = true;
        }
        if (!applied) {
            const grossTotal = lines.reduce((s, l) => s + grossOf(l), 0);
            console.log("[Guper v2] fallback base total(c/imposto)=", grossTotal);
            if (grossTotal > 0) {
                const pct = ((amount / 100) / grossTotal) * 100;
                lines.forEach((l) => addDiscount(l, pct));
            }
        }

        order.guper_redeem_amount = amount;
        order.guper_order_ref = orderRef; // usado no fechamento
        this.notification.add(_t("Cashback aplicado."), { type: "success" });
    }

    _guperItems(order) {
        return order
            .get_orderlines()
            .filter((l) => l.get_quantity() > 0 && (l.get_unit_price() || 0) >= 0)
            .map((l) => {
                const p = l.get_product();
                return {
                    id: p.default_code || String(p.id),
                    name: p.display_name,
                    quantity: Math.round(l.get_quantity()),
                    price: Math.round((l.get_unit_price() || 0) * 100),
                    productId: String(p.id),
                };
            });
    }

    async _guperCall(path, params) {
        const res = await fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "call", params }),
        });
        const data = await res.json();
        if (data.error) {
            throw new Error(
                data.error.data?.message ||
                    data.error.data?.arguments?.[0] ||
                    data.error.message ||
                    "error desconocido"
            );
        }
        return data.result;
    }
}

ProductScreen.addControlButton({ component: GuperCashbackButton });
