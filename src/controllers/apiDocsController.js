import { getSettings } from './settingsController.js';

export const index = async (req, res) => {
  const settings = await getSettings();
  const baseUrl = settings.baseUrl || `${req.protocol}://${req.get('host')}`;
  res.render('api-docs/index', { title: 'API Documentation', baseUrl });
};
