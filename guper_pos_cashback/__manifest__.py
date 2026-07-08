{
    'name': 'Guper POS Cashback',
    'version': '19.0.1.1.2',
    'summary': 'Geracao e resgate de cashback Guper no Point of Sale (com PIN por WhatsApp)',
    'author': 'Guper',
    'website': 'https://guper.co',
    'license': 'LGPL-3',
    'category': 'Sales/Point of Sale',
    'depends': ['point_of_sale'],
    'data': [
        'security/ir.model.access.csv',
        'data/guper_data.xml',
        'data/guper_cron.xml',
        'views/pos_config_views.xml',
    ],
    'assets': {
        # Bundle do POS no Odoo 17/18
        'point_of_sale._assets_pos': [
            'guper_pos_cashback/static/src/**/*',
        ],
    },
    'installable': True,
    'application': False,
}
